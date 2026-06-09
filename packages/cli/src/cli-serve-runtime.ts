import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import {
  type AppBindingMaterializationResult,
  type AppBindingMaterializer,
  type AppInstallationImportDataRestorer,
  type AppInstallationMaterializeWorker,
  type AppInstallationMaterializeWorkerResult,
  createOpenManagedOfferingAccessPolicy,
  customOidcOAuthProvider,
  InMemorySharedCellWarmPool,
  type InstallationExportArchiveDataFile,
  type DeployControlProxyOptions,
  isAppBindingKind,
  type ManagedOfferingAccessPolicy,
  type PasskeyHttpOptions,
  type SharedCellWarmPoolSlot,
  type StripeBillingOptions,
  type UpstreamOAuthOptions,
  type WorkloadPlatformServiceResolverHttpOptions,
} from "@takosjp/takosumi-accounts-service";
import {
  optionalEnvString,
  optionalIntegerOption,
  optionalStringOption,
  validateHttpUrl,
} from "./cli-options.ts";
import {
  accountsApiErrorMessage,
  isRecord,
  optionalStringRecord,
  stringArrayValue,
  stringValue,
} from "./cli-util.ts";
import {
  checkedEvidenceRef,
  formatManagedOfferingReadinessReport,
  isSha256Digest,
  managedOfferingPublicSummaryErrors,
  managedOfferingReadinessDigest,
  validateManagedOfferingReadinessDocument,
} from "./cli-managed-offering.ts";
import {
  absolutePath,
  joinPath,
  parentPath,
} from "./cli-git-ops.ts";

const bindingNamePattern = /^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/;

interface StaticBindingMaterial {
  kind?: string;
  configRef: string;
  secretRefs?: readonly string[];
  env?: Record<string, string>;
}

export interface StaticBindingMaterializerConfig {
  source:
    | "--use-edge-materials-file"
    | "TAKOSUMI_ACCOUNTS_USE_EDGE_MATERIALS";
  materials: ReadonlyMap<string, StaticBindingMaterial>;
}

export interface SharedCellWarmPoolConfig {
  source: "--shared-cell-slots" | "TAKOSUMI_ACCOUNTS_SHARED_CELL_SLOTS";
  slots: readonly SharedCellWarmPoolSlot[];
}

export type SharedCellScaleOutPolicy =
  | { strategy: "manual" }
  | {
    strategy: "available-slots";
    minAvailableSlots: number;
    maxCells: number;
  };

export interface SharedCellScaleOutPolicyConfig {
  source:
    | "--shared-cell-scale-out-policy"
    | "TAKOSUMI_ACCOUNTS_SHARED_CELL_SCALE_OUT_POLICY";
  policy: SharedCellScaleOutPolicy;
}

export interface MetadataExportWorkerConfig {
  source: string;
  outputDirectory: string;
  downloadBaseUrl: string;
  dataDirectory?: string;
  ttlMs?: number;
}

export interface HttpMaterializeWorkerConfig {
  source: string;
  url: string;
  token?: string;
}

export interface WorkloadPlatformServiceResolverConfig
  extends WorkloadPlatformServiceResolverHttpOptions {
  source:
    | "--workload-platform-service-resolver-token"
    | "TAKOSUMI_ACCOUNTS_WORKLOAD_PLATFORM_SERVICE_RESOLVER_TOKEN";
}

export interface ManagedOfferingAccessConfig
  extends ManagedOfferingAccessPolicy {
  source:
    | "--managed-offering-access"
    | "--managed-offering-readiness-file"
    | "default";
  readinessFile?: string;
  readinessDigest?: string;
  approvalRef?: string;
}

export interface StaticImportDataRestorerConfig {
  source:
    | "--import-data-restore-dir"
    | "TAKOSUMI_ACCOUNTS_IMPORT_DATA_RESTORE_DIR";
  outputDirectory: string;
}

export function buildStripeBillingOptions(
  options: Record<string, string | boolean>,
): StripeBillingOptions | undefined {
  const secretKey = optionalStringOption(options, "stripeSecretKey");
  const webhookSecret = optionalStringOption(options, "stripeWebhookSecret");
  const stripeApiBase = optionalStringOption(options, "stripeApiBase");
  const webhookToleranceSeconds = optionalIntegerOption(
    options,
    "stripeWebhookToleranceSeconds",
  );

  const hasStripeOption = Boolean(
    secretKey || webhookSecret || stripeApiBase || webhookToleranceSeconds,
  );
  if (!hasStripeOption) return undefined;
  if (!secretKey || !webhookSecret) {
    throw new TypeError(
      "Stripe billing requires --stripe-secret-key and --stripe-webhook-secret",
    );
  }

  return {
    secretKey,
    webhookSecret,
    stripeApiBase,
    webhookToleranceSeconds,
  };
}

export async function buildManagedOfferingAccessConfig(
  options: Record<string, string | boolean>,
): Promise<ManagedOfferingAccessConfig> {
  const rawStatus = optionalStringOption(options, "managedOfferingAccess") ??
    "closed";
  if (rawStatus !== "closed" && rawStatus !== "open") {
    throw new TypeError(
      "--managed-offering-access must be one of: closed, open",
    );
  }

  const readinessFile = optionalStringOption(
    options,
    "managedOfferingReadinessFile",
  );
  const evidenceRef = optionalStringOption(
    options,
    "managedOfferingEvidenceRef",
  );
  const readinessDigest = optionalStringOption(
    options,
    "managedOfferingReadinessDigest",
  );
  const publicSummary = optionalStringOption(
    options,
    "managedOfferingPublicSummary",
  );
  const approvalRef = optionalStringOption(
    options,
    "managedOfferingApprovalRef",
  );

  if (rawStatus === "closed") {
    return {
      status: "closed",
      source: readinessFile
        ? "--managed-offering-readiness-file"
        : options.managedOfferingAccess
        ? "--managed-offering-access"
        : "default",
      ...(readinessFile ? { readinessFile } : {}),
      ...(readinessDigest ? { readinessDigest } : {}),
      ...(evidenceRef ? { evidenceRef } : {}),
      ...(publicSummary ? { publicSummary } : {}),
      ...(approvalRef ? { approvalRef } : {}),
    };
  }

  if (!readinessFile) {
    throw new TypeError(
      "--managed-offering-access open requires --managed-offering-readiness-file",
    );
  }
  if (!evidenceRef || !publicSummary || !approvalRef) {
    throw new TypeError(
      "--managed-offering-access open requires --managed-offering-evidence-ref, --managed-offering-public-summary, and --managed-offering-approval-ref",
    );
  }
  if (!readinessDigest) {
    throw new TypeError(
      "--managed-offering-access open requires --managed-offering-readiness-digest",
    );
  }
  if (!isSha256Digest(readinessDigest)) {
    throw new TypeError(
      "--managed-offering-readiness-digest must be a sha256: digest",
    );
  }
  const evidenceRefResult = checkedEvidenceRef(
    evidenceRef,
    "--managed-offering-evidence-ref",
  );
  if (evidenceRefResult.errors.length > 0) {
    throw new TypeError(evidenceRefResult.errors.join("\n"));
  }
  const approvalRefResult = checkedEvidenceRef(
    approvalRef,
    "--managed-offering-approval-ref",
  );
  if (approvalRefResult.errors.length > 0) {
    throw new TypeError(approvalRefResult.errors.join("\n"));
  }
  if (evidenceRefResult.ref === approvalRefResult.ref) {
    throw new TypeError(
      "--managed-offering-approval-ref must differ from --managed-offering-evidence-ref",
    );
  }
  const publicSummaryErrors = managedOfferingPublicSummaryErrors(
    publicSummary,
    { requireLaunchScope: true },
  );
  if (publicSummaryErrors.length > 0) {
    throw new TypeError(publicSummaryErrors.join("\n"));
  }

  let document;
  try {
    document = JSON.parse(await readFile(readinessFile, "utf8"));
  } catch (error) {
    throw new TypeError(
      `Failed to read managed offering readiness evidence: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const computedDigest = await managedOfferingReadinessDigest(document);
  if (readinessDigest !== computedDigest) {
    throw new TypeError(
      "--managed-offering-readiness-digest must match the readiness file digest",
    );
  }
  const report = validateManagedOfferingReadinessDocument(document);
  if (!report.ready) {
    throw new TypeError(formatManagedOfferingReadinessReport(report));
  }

  const policy = createOpenManagedOfferingAccessPolicy(
    {
      evidenceRef: evidenceRefResult.ref,
      approvalRef: approvalRefResult.ref,
      publicSummary: publicSummary.trim(),
    },
    {
      ready: true,
      evidenceDigest: computedDigest,
    },
  );
  return Object.assign(policy, {
    source: "--managed-offering-access" as const,
    readinessFile,
  });
}

export function buildUpstreamOAuthOptions(
  options: Record<string, string | boolean>,
): UpstreamOAuthOptions | undefined {
  const providers = [
    upstreamProviderOption(options, "github"),
    upstreamProviderOption(options, "google"),
    customOidcProviderOption(options),
  ].filter((provider) => provider !== undefined);
  const subjectSecret = optionalStringOption(options, "subjectSecret");
  const sessionTtlMs = optionalIntegerOption(options, "upstreamSessionTtlMs");

  const hasUpstreamOption = Boolean(
    subjectSecret || sessionTtlMs || providers.length > 0,
  );
  if (!hasUpstreamOption) return undefined;
  if (!subjectSecret) {
    throw new TypeError("Upstream OAuth requires --subject-secret");
  }
  if (providers.length === 0) {
    throw new TypeError(
      "Upstream OAuth requires at least one provider client",
    );
  }
  assertUniqueUpstreamProviderIds(providers);

  return {
    subjectSecret,
    providers,
    sessionTtlMs,
  };
}

export function buildPasskeyOptions(
  options: Record<string, string | boolean>,
): PasskeyHttpOptions | undefined {
  const rpId = optionalStringOption(options, "passkeyRpId");
  const rpName = optionalStringOption(options, "passkeyRpName");
  const origin = optionalStringOption(options, "passkeyOrigin");
  const sessionTtlMs = optionalIntegerOption(options, "passkeySessionTtlMs");

  const hasPasskeyOption = Boolean(rpId || rpName || origin || sessionTtlMs);
  if (!hasPasskeyOption) return undefined;
  if (!rpId || !rpName || !origin) {
    throw new TypeError(
      "Passkeys require --passkey-rp-id, --passkey-rp-name, and --passkey-origin",
    );
  }

  return {
    rpId,
    rpName,
    origin,
    sessionTtlMs,
  };
}

export async function buildDeployControlProxyOptions(
  options: Record<string, string | boolean>,
): Promise<DeployControlProxyOptions | undefined> {
  const url = optionalStringOption(options, "deployControlUrl") ??
    await optionalEnvString("TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL");
  const token = optionalStringOption(options, "deployControlToken") ??
    await optionalEnvString("TAKOSUMI_DEPLOY_CONTROL_TOKEN");
  if (!url && !token) return undefined;
  if (!url) {
    throw new TypeError(
      "--deploy-control-url or TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL is required when configuring deploy control proxy",
    );
  }
  return {
    url: validateHttpUrl(url, "--deploy-control-url"),
    ...(token ? { token } : {}),
  };
}

export async function buildStaticBindingMaterializerConfig(
  options: Record<string, string | boolean>,
): Promise<StaticBindingMaterializerConfig | undefined> {
  if (options.useEdgeMaterialsFile === true) {
    throw new TypeError("--use-edge-materials-file requires a value");
  }
  const file = optionalStringOption(options, "useEdgeMaterialsFile");
  const rawEnv = await optionalEnvString(
    "TAKOSUMI_ACCOUNTS_USE_EDGE_MATERIALS",
  );
  if (!file && !rawEnv) return undefined;
  if (file && rawEnv) {
    throw new TypeError(
      "Use either --use-edge-materials-file or TAKOSUMI_ACCOUNTS_USE_EDGE_MATERIALS, not both",
    );
  }
  const raw = file ? await readFile(file, "utf8") : rawEnv;
  return {
    source: file
      ? "--use-edge-materials-file"
      : "TAKOSUMI_ACCOUNTS_USE_EDGE_MATERIALS",
    materials: parseStaticBindingMaterials(raw ?? "{}"),
  };
}

export async function buildSharedCellWarmPoolConfig(
  options: Record<string, string | boolean>,
): Promise<SharedCellWarmPoolConfig | undefined> {
  if (options.sharedCellSlots === true) {
    throw new TypeError("--shared-cell-slots requires a value");
  }
  const cliSlots = optionalStringOption(options, "sharedCellSlots");
  const envSlots = await optionalEnvString(
    "TAKOSUMI_ACCOUNTS_SHARED_CELL_SLOTS",
  );
  if (!cliSlots && !envSlots) return undefined;
  if (cliSlots && envSlots) {
    throw new TypeError(
      "Use either --shared-cell-slots or TAKOSUMI_ACCOUNTS_SHARED_CELL_SLOTS, not both",
    );
  }
  const slots = parseSharedCellWarmPoolSlots(cliSlots ?? envSlots ?? "");
  new InMemorySharedCellWarmPool(slots);
  return {
    source: cliSlots
      ? "--shared-cell-slots"
      : "TAKOSUMI_ACCOUNTS_SHARED_CELL_SLOTS",
    slots,
  };
}

export async function buildSharedCellScaleOutPolicyConfig(
  options: Record<string, string | boolean>,
): Promise<SharedCellScaleOutPolicyConfig | undefined> {
  if (options.sharedCellScaleOutPolicy === true) {
    throw new TypeError("--shared-cell-scale-out-policy requires a value");
  }
  const cliPolicy = optionalStringOption(options, "sharedCellScaleOutPolicy");
  const envPolicy = await optionalEnvString(
    "TAKOSUMI_ACCOUNTS_SHARED_CELL_SCALE_OUT_POLICY",
  );
  if (!cliPolicy && !envPolicy) return undefined;
  if (cliPolicy && envPolicy) {
    throw new TypeError(
      "Use either --shared-cell-scale-out-policy or TAKOSUMI_ACCOUNTS_SHARED_CELL_SCALE_OUT_POLICY, not both",
    );
  }
  return {
    source: cliPolicy
      ? "--shared-cell-scale-out-policy"
      : "TAKOSUMI_ACCOUNTS_SHARED_CELL_SCALE_OUT_POLICY",
    policy: parseSharedCellScaleOutPolicy(cliPolicy ?? envPolicy ?? ""),
  };
}

export async function buildHttpMaterializeWorkerConfig(
  options: Record<string, string | boolean>,
): Promise<HttpMaterializeWorkerConfig | undefined> {
  if (options.materializeWorkerUrl === true) {
    throw new TypeError("--materialize-worker-url requires a value");
  }
  if (options.materializeWorkerToken === true) {
    throw new TypeError("--materialize-worker-token requires a value");
  }
  const cliUrl = optionalStringOption(options, "materializeWorkerUrl");
  const envUrl = await optionalEnvString(
    "TAKOSUMI_ACCOUNTS_MATERIALIZE_WORKER_URL",
  );
  const token = optionalStringOption(options, "materializeWorkerToken") ??
    await optionalEnvString("TAKOSUMI_ACCOUNTS_MATERIALIZE_WORKER_TOKEN");
  if (!cliUrl && !envUrl && !token) return undefined;
  if (cliUrl && envUrl) {
    throw new TypeError(
      "Use either --materialize-worker-url or TAKOSUMI_ACCOUNTS_MATERIALIZE_WORKER_URL, not both",
    );
  }
  const url = cliUrl ?? envUrl;
  if (!url) {
    throw new TypeError(
      "Materialize worker requires --materialize-worker-url or TAKOSUMI_ACCOUNTS_MATERIALIZE_WORKER_URL",
    );
  }
  return {
    source: cliUrl
      ? "--materialize-worker-url"
      : "TAKOSUMI_ACCOUNTS_MATERIALIZE_WORKER_URL",
    url: validateHttpUrl(url, "--materialize-worker-url"),
    ...(token ? { token } : {}),
  };
}

export async function buildWorkloadPlatformServiceResolverConfig(
  options: Record<string, string | boolean>,
): Promise<WorkloadPlatformServiceResolverConfig | undefined> {
  if (options.workloadPlatformServiceResolverToken === true) {
    throw new TypeError(
      "--workload-platform-service-resolver-token requires a value",
    );
  }
  if (options.billingPortalUrl === true) {
    throw new TypeError("--billing-portal-url requires a value");
  }
  const cliToken = optionalStringOption(
    options,
    "workloadPlatformServiceResolverToken",
  );
  const envToken = await optionalEnvString(
    "TAKOSUMI_ACCOUNTS_WORKLOAD_PLATFORM_SERVICE_RESOLVER_TOKEN",
  );
  const billingPortalUrl = optionalStringOption(options, "billingPortalUrl") ??
    await optionalEnvString("TAKOSUMI_ACCOUNTS_BILLING_PORTAL_URL");
  if (cliToken && envToken) {
    throw new TypeError(
      "Use either --workload-platform-service-resolver-token or TAKOSUMI_ACCOUNTS_WORKLOAD_PLATFORM_SERVICE_RESOLVER_TOKEN, not both",
    );
  }
  const token = cliToken ?? envToken;
  if (!token) {
    if (billingPortalUrl) {
      throw new TypeError(
        "--billing-portal-url requires --workload-platform-service-resolver-token or TAKOSUMI_ACCOUNTS_WORKLOAD_PLATFORM_SERVICE_RESOLVER_TOKEN",
      );
    }
    return undefined;
  }
  return {
    source: cliToken
      ? "--workload-platform-service-resolver-token"
      : "TAKOSUMI_ACCOUNTS_WORKLOAD_PLATFORM_SERVICE_RESOLVER_TOKEN",
    token,
    ...(billingPortalUrl
      ? {
        billingPortalUrl: validateHttpUrl(
          billingPortalUrl,
          "--billing-portal-url",
        ),
      }
      : {}),
  };
}

export async function buildMetadataExportWorkerConfig(
  options: Record<string, string | boolean>,
): Promise<MetadataExportWorkerConfig | undefined> {
  if (options.exportOutputDir === true) {
    throw new TypeError("--export-output-dir requires a value");
  }
  if (options.exportDownloadBaseUrl === true) {
    throw new TypeError("--export-download-base-url requires a value");
  }
  if (options.exportDataDir === true) {
    throw new TypeError("--export-data-dir requires a value");
  }
  const outputDirectory = optionalStringOption(options, "exportOutputDir") ??
    await optionalEnvString("TAKOSUMI_ACCOUNTS_EXPORT_OUTPUT_DIR");
  const downloadBaseUrl = optionalStringOption(
    options,
    "exportDownloadBaseUrl",
  ) ?? await optionalEnvString("TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_BASE_URL");
  const dataDirectory = optionalStringOption(options, "exportDataDir") ??
    await optionalEnvString("TAKOSUMI_ACCOUNTS_EXPORT_DATA_DIR");
  const ttlMs = optionalIntegerOption(options, "exportDownloadTtlMs");
  const hasExportWorkerOption = Boolean(
    outputDirectory || downloadBaseUrl || dataDirectory || ttlMs,
  );
  if (!hasExportWorkerOption) return undefined;
  if (!outputDirectory || !downloadBaseUrl) {
    throw new TypeError(
      "Metadata export worker requires --export-output-dir and --export-download-base-url",
    );
  }
  return {
    source: options.exportOutputDir || options.exportDownloadBaseUrl
      ? "--export-output-dir/--export-download-base-url"
      : "TAKOSUMI_ACCOUNTS_EXPORT_OUTPUT_DIR",
    outputDirectory,
    downloadBaseUrl: validateHttpUrl(
      downloadBaseUrl,
      "--export-download-base-url",
    ),
    ...(dataDirectory ? { dataDirectory } : {}),
    ...(ttlMs ? { ttlMs } : {}),
  };
}

export async function buildStaticImportDataRestorerConfig(
  options: Record<string, string | boolean>,
): Promise<StaticImportDataRestorerConfig | undefined> {
  if (options.importDataRestoreDir === true) {
    throw new TypeError("--import-data-restore-dir requires a value");
  }
  const cliDirectory = optionalStringOption(options, "importDataRestoreDir");
  const envDirectory = await optionalEnvString(
    "TAKOSUMI_ACCOUNTS_IMPORT_DATA_RESTORE_DIR",
  );
  if (cliDirectory && envDirectory) {
    throw new TypeError(
      "Use either --import-data-restore-dir or TAKOSUMI_ACCOUNTS_IMPORT_DATA_RESTORE_DIR, not both",
    );
  }
  const outputDirectory = cliDirectory ?? envDirectory;
  if (!outputDirectory) return undefined;
  return {
    source: cliDirectory
      ? "--import-data-restore-dir"
      : "TAKOSUMI_ACCOUNTS_IMPORT_DATA_RESTORE_DIR",
    outputDirectory,
  };
}

function parseSharedCellWarmPoolSlots(
  value: string,
): readonly SharedCellWarmPoolSlot[] {
  const slots = value.split(",").map((entry) => entry.trim()).filter(Boolean)
    .map((entry) => {
      const [cellId, capacityText, ...rest] = entry.split(":");
      if (!cellId || !capacityText || rest.length > 0) {
        throw new TypeError(
          "shared-cell slots must use cell-id:capacity entries",
        );
      }
      const capacity = Number(capacityText);
      if (!Number.isInteger(capacity) || capacity < 1) {
        throw new TypeError(
          "shared-cell slot capacity must be a positive integer",
        );
      }
      return { cellId, capacity };
    });
  if (slots.length === 0) {
    throw new TypeError("shared-cell slots must include at least one slot");
  }
  return slots;
}

function parseSharedCellScaleOutPolicy(
  value: string,
): SharedCellScaleOutPolicy {
  let policy: unknown;
  try {
    policy = JSON.parse(value);
  } catch {
    throw new TypeError("shared-cell scale-out policy must be valid JSON");
  }
  if (!isRecord(policy)) {
    throw new TypeError(
      "shared-cell scale-out policy must be a JSON object",
    );
  }
  if (policy.strategy === "manual") {
    return { strategy: "manual" };
  }
  if (policy.strategy !== "available-slots") {
    throw new TypeError(
      "shared-cell scale-out policy strategy must be manual or available-slots",
    );
  }
  const minAvailableSlots = policy.minAvailableSlots;
  if (
    typeof minAvailableSlots !== "number" ||
    !Number.isInteger(minAvailableSlots) ||
    minAvailableSlots < 0
  ) {
    throw new TypeError(
      "shared-cell scale-out policy minAvailableSlots must be a non-negative integer",
    );
  }
  const maxCells = policy.maxCells;
  if (
    typeof maxCells !== "number" ||
    !Number.isInteger(maxCells) ||
    maxCells < 1
  ) {
    throw new TypeError(
      "shared-cell scale-out policy maxCells must be a positive integer",
    );
  }
  return {
    strategy: "available-slots",
    minAvailableSlots,
    maxCells,
  };
}

function parseStaticBindingMaterials(
  text: string,
): ReadonlyMap<string, StaticBindingMaterial> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError("use edge materials must be valid JSON");
  }
  if (!isRecord(value)) {
    throw new TypeError("use edge materials must be a JSON object");
  }
  const materials = new Map<string, StaticBindingMaterial>();
  for (const [name, material] of Object.entries(value)) {
    if (!bindingNamePattern.test(name)) {
      throw new TypeError(
        `use edge material key '${name}' must be a valid use edge name`,
      );
    }
    if (!isRecord(material)) {
      throw new TypeError(`use edge material '${name}' must be an object`);
    }
    const kind = stringValue(material.kind);
    const configRef = stringValue(material.configRef) ??
      stringValue(material.config_ref);
    if (!configRef) {
      throw new TypeError(
        `use edge material '${name}' requires configRef`,
      );
    }
    const secretRefs = stringArrayValue(
      material.secretRefs ?? material.secret_refs,
      `use edge material '${name}'.secretRefs`,
    );
    const env = optionalStringRecord(
      material.env,
      `use edge material '${name}'.env`,
    );
    materials.set(name, {
      ...(kind ? { kind } : {}),
      configRef,
      ...(secretRefs ? { secretRefs } : {}),
      ...(env ? { env } : {}),
    });
  }
  return materials;
}

export function staticBindingMaterializer(
  materials: ReadonlyMap<string, StaticBindingMaterial>,
): AppBindingMaterializer {
  return (
    { installation, binding },
  ): AppBindingMaterializationResult | undefined => {
    const material = materials.get(binding.name);
    if (!material) return undefined;
    if (material.kind && material.kind !== binding.kind) {
      throw new TypeError(
        `use edge material '${binding.name}' kind ${material.kind} does not match ${binding.kind}`,
      );
    }
    return {
      configRef: renderBindingMaterialString(
        material.configRef,
        installation.installationId,
        binding.name,
      ),
      secretRefs: material.secretRefs?.map((value) =>
        renderBindingMaterialString(
          value,
          installation.installationId,
          binding.name,
        )
      ),
      env: material.env
        ? Object.fromEntries(
          Object.entries(material.env).map(([key, value]) => [
            key,
            renderBindingMaterialString(
              value,
              installation.installationId,
              binding.name,
            ),
          ]),
        )
        : undefined,
    };
  };
}

export function composeBindingMaterializers(
  materializers: readonly AppBindingMaterializer[],
): AppBindingMaterializer | undefined {
  if (materializers.length === 0) return undefined;
  return async (input) => {
    for (const materializer of materializers) {
      const result = await materializer(input);
      if (result) return result;
    }
    return undefined;
  };
}

export function bindingMaterializerPlan(input: {
  staticConfig?: StaticBindingMaterializerConfig;
}): Record<string, unknown> {
  if (input.staticConfig) {
    return {
      configured: true,
      source: input.staticConfig.source,
      bindings: [...input.staticConfig.materials.keys()].sort(),
    };
  }
  return { configured: false };
}

export function httpMaterializeWorker(
  config: HttpMaterializeWorkerConfig,
): AppInstallationMaterializeWorker {
  return async (input) => {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (config.token) headers.authorization = `Bearer ${config.token}`;
    const response = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "takosumi.accounts.materialize-worker-request@v1",
        installation: input.installation,
        operationId: input.operationId,
        request: input.request,
        preserve: input.preserve,
        preserveDigest: input.preserveDigest,
      }),
    });
    const text = await response.text();
    const body = text.trim().length > 0
      ? parseMaterializeWorkerJson(text)
      : undefined;
    if (!response.ok) {
      throw new Error(
        accountsApiErrorMessage(
          body,
          `materialize worker returned HTTP ${response.status}`,
        ),
      );
    }
    return materializeWorkerResultFromValue(body);
  };
}

function parseMaterializeWorkerJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("materialize worker returned invalid JSON");
  }
}

function materializeWorkerResultFromValue(
  value: unknown,
): AppInstallationMaterializeWorkerResult {
  const result = isRecord(value) && isRecord(value.result)
    ? value.result
    : value;
  if (!isRecord(result)) {
    throw new TypeError("materialize worker response must be an object");
  }
  const preserveDigest = stringValue(result.preserveDigest);
  const reason = stringValue(result.reason);
  return {
    runtimeTarget: parseMaterializeRuntimeTarget(result.runtimeTarget),
    continuity: parseMaterializeContinuity(result.continuity),
    ...(preserveDigest !== undefined ? { preserveDigest } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

function parseMaterializeRuntimeTarget(
  value: unknown,
): AppInstallationMaterializeWorkerResult["runtimeTarget"] {
  if (!isRecord(value)) {
    throw new TypeError("materialize.runtimeTarget must be an object");
  }
  const targetId = stringValue(value.targetId);
  if (!targetId) {
    throw new TypeError("materialize.runtimeTarget.targetId is required");
  }
  const targetTypeRaw = stringValue(value.targetType);
  if (targetTypeRaw !== undefined && targetTypeRaw !== "dedicated") {
    throw new TypeError(
      `materialize.runtimeTarget.targetType must be "dedicated"`,
    );
  }
  const runtimeTargetId = stringValue(value.runtimeTargetId);
  return {
    targetId,
    ...(runtimeTargetId !== undefined ? { runtimeTargetId } : {}),
    ...(targetTypeRaw === "dedicated" ? { targetType: "dedicated" } : {}),
  };
}

function parseMaterializeContinuity(
  value: unknown,
): AppInstallationMaterializeWorkerResult["continuity"] {
  if (!isRecord(value)) {
    throw new TypeError("materialize.continuity must be an object");
  }
  return {
    sourceDataNamespace: parseNullableString(
      value.sourceDataNamespace,
      "materialize.continuity.sourceDataNamespace",
    ),
    oidcClient: parseNullableRecord(
      value.oidcClient,
      "materialize.continuity.oidcClient",
    ),
    preservedUseEdges: parseMaterializePreservedUseEdges(
      value.preservedUseEdges,
    ),
    cutover: parseMaterializeCutover(value.cutover),
  };
}

function parseMaterializePreservedUseEdges(
  value: unknown,
): AppInstallationMaterializeWorkerResult["continuity"]["preservedUseEdges"] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(
      "materialize.continuity.preservedUseEdges must be an array",
    );
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(
        `materialize.continuity.preservedUseEdges[${index}] must be an object`,
      );
    }
    const name = stringValue(entry.name);
    const kindRaw = stringValue(entry.kind);
    const configRef = stringValue(entry.configRef);
    if (!name || !kindRaw || !configRef) {
      throw new TypeError(
        `materialize.continuity.preservedUseEdges[${index}] requires name, kind, configRef`,
      );
    }
    if (!isAppBindingKind(kindRaw)) {
      throw new TypeError(
        `materialize.continuity.preservedUseEdges[${index}].kind '${kindRaw}' is not a recognized use edge kind`,
      );
    }
    const secretRefs = stringArrayValue(
      entry.secretRefs,
      `materialize.continuity.preservedUseEdges[${index}].secretRefs`,
    ) ?? [];
    return { name, kind: kindRaw, configRef, secretRefs };
  });
}

function parseMaterializeCutover(
  value: unknown,
): AppInstallationMaterializeWorkerResult["continuity"]["cutover"] {
  if (!isRecord(value)) {
    throw new TypeError("materialize.continuity.cutover must be an object");
  }
  const toTargetId = stringValue(value.toTargetId);
  if (!toTargetId) {
    throw new TypeError(
      "materialize.continuity.cutover.toTargetId is required",
    );
  }
  if (typeof value.ready !== "boolean") {
    throw new TypeError(
      "materialize.continuity.cutover.ready must be a boolean",
    );
  }
  const strategy = stringValue(value.strategy);
  return {
    fromTargetId: parseNullableString(
      value.fromTargetId,
      "materialize.continuity.cutover.fromTargetId",
    ),
    toTargetId,
    ready: value.ready,
    ...(strategy !== undefined ? { strategy } : {}),
  };
}

function parseNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  const parsed = stringValue(value);
  if (parsed === undefined) {
    throw new TypeError(`${label} must be a string or null`);
  }
  return parsed;
}

function parseNullableRecord(
  value: unknown,
  label: string,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object or null`);
  }
  return value;
}

export function staticExportDataProvider(
  dataDirectory: string,
): () => Promise<readonly InstallationExportArchiveDataFile[]> {
  return async () => await readStaticExportDataFiles(dataDirectory);
}

async function readStaticExportDataFiles(
  root: string,
  relativeDirectory = "",
): Promise<readonly InstallationExportArchiveDataFile[]> {
  const directory = relativeDirectory
    ? joinPath(root, relativeDirectory)
    : root;
  const files: InstallationExportArchiveDataFile[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "." || entry.name === "..") continue;
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      files.push(...await readStaticExportDataFiles(root, relativePath));
      continue;
    }
    if (!entry.isFile()) continue;
    files.push({
      path: relativePath,
      content: await readFile(joinPath(root, relativePath)),
      ...(guessMediaType(relativePath)
        ? { mediaType: guessMediaType(relativePath) }
        : {}),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function staticImportDataRestorer(
  outputDirectory: string,
): AppInstallationImportDataRestorer {
  return async (input) => {
    const restoredEntries: string[] = [];
    for (const entry of input.entries) {
      const relativePath = importDataRelativePath(entry.path);
      const targetPath = joinPath(
        outputDirectory,
        input.installation.installationId,
        relativePath,
      );
      await mkdir(parentPath(targetPath), { recursive: true });
      await writeFile(targetPath, entry.content);
      restoredEntries.push(entry.path);
    }
    return {
      restoredEntries,
      evidence: {
        outputDirectory,
      },
    };
  };
}

function importDataRelativePath(path: string): string {
  const prefix = "takos-export/data/";
  if (!path.startsWith(prefix)) {
    throw new TypeError(`import data path must start with ${prefix}`);
  }
  const relativePath = path.slice(prefix.length);
  if (
    !relativePath ||
    relativePath.split("/").some((segment) =>
      segment === "." || segment === ".." || segment.length === 0
    )
  ) {
    throw new TypeError(`unsafe import data path: ${path}`);
  }
  return relativePath;
}

function guessMediaType(path: string): string | undefined {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".sql")) return "application/sql";
  if (path.endsWith(".txt")) return "text/plain";
  return undefined;
}

function renderBindingMaterialString(
  value: string,
  installationId: string,
  bindingName: string,
): string {
  return value
    .replaceAll("${installation.id}", installationId)
    .replaceAll("${installationId}", installationId)
    .replaceAll("${binding.name}", bindingName)
    .replaceAll("${bindingName}", bindingName);
}

function upstreamProviderOption(
  options: Record<string, string | boolean>,
  providerId: "github" | "google",
): UpstreamOAuthOptions["providers"][number] | undefined {
  const prefix = providerId;
  const clientId = optionalStringOption(options, `${prefix}ClientId`);
  const clientSecret = optionalStringOption(options, `${prefix}ClientSecret`);
  const redirectUri = optionalStringOption(options, `${prefix}RedirectUri`);
  if (!clientId && !clientSecret && !redirectUri) return undefined;
  if (!clientId || !redirectUri) {
    throw new TypeError(
      `--${providerId}-client-id and --${providerId}-redirect-uri are required together`,
    );
  }
  return {
    providerId,
    clientId,
    clientSecret,
    redirectUri,
  };
}

function customOidcProviderOption(
  options: Record<string, string | boolean>,
): UpstreamOAuthOptions["providers"][number] | undefined {
  const providerId = optionalStringOption(options, "oidcProviderId") ?? "oidc";
  const issuer = optionalStringOption(options, "oidcIssuer");
  const authorizationEndpoint = optionalStringOption(
    options,
    "oidcAuthorizationEndpoint",
  );
  const tokenEndpoint = optionalStringOption(options, "oidcTokenEndpoint");
  const userInfoEndpoint = optionalStringOption(
    options,
    "oidcUserinfoEndpoint",
  );
  const clientId = optionalStringOption(options, "oidcClientId");
  const clientSecret = optionalStringOption(options, "oidcClientSecret");
  const redirectUri = optionalStringOption(options, "oidcRedirectUri");
  const scopes = splitScopes(optionalStringOption(options, "oidcScopes"));
  const subjectClaim = optionalStringOption(options, "oidcSubjectClaim");
  const hasOidcOption = Boolean(
    issuer ||
      authorizationEndpoint ||
      tokenEndpoint ||
      userInfoEndpoint ||
      clientId ||
      clientSecret ||
      redirectUri ||
      scopes.length > 0 ||
      subjectClaim ||
      options.oidcProviderId,
  );
  if (!hasOidcOption) return undefined;

  const missing = [
    [issuer, "--oidc-issuer"],
    [authorizationEndpoint, "--oidc-authorization-endpoint"],
    [tokenEndpoint, "--oidc-token-endpoint"],
    [userInfoEndpoint, "--oidc-userinfo-endpoint"],
    [clientId, "--oidc-client-id"],
    [redirectUri, "--oidc-redirect-uri"],
  ].filter(([value]) => !value).map(([, flag]) => flag);
  if (missing.length > 0) {
    throw new TypeError(
      `OIDC upstream provider requires ${missing.join(", ")}`,
    );
  }

  return {
    providerId,
    clientId: clientId!,
    clientSecret,
    redirectUri: redirectUri!,
    scopes: scopes.length > 0 ? scopes : undefined,
    provider: customOidcOAuthProvider({
      id: providerId,
      issuer: issuer!,
      authorizationEndpoint: authorizationEndpoint!,
      tokenEndpoint: tokenEndpoint!,
      userInfoEndpoint: userInfoEndpoint!,
      defaultScopes: scopes.length > 0 ? scopes : undefined,
      subjectClaim,
    }),
  };
}

function assertUniqueUpstreamProviderIds(
  providers: readonly UpstreamOAuthOptions["providers"][number][],
): void {
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.providerId)) {
      throw new TypeError(
        `Upstream OAuth provider '${provider.providerId}' is configured more than once`,
      );
    }
    seen.add(provider.providerId);
  }
}

function splitScopes(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
}
