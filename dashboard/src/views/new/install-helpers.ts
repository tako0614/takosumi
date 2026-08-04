/**
 * /new install flow — pure helpers (no JSX, no component state).
 *
 * Shared with InstallView.tsx so the view file holds only the flow state
 * machine and rendering. Everything here is presentation-independent: store
 * listing → StoreEntry/metadata mapping, compatibility result display,
 * git/slug/url normalization, install-variable row plumbing, and the
 * store-input defaulting rules the one-tap install path relies on.
 */
import {
  normalizeInstallConfigSourcePath,
  normalizeInstallConfigSourceUrl,
  type JsonValue,
} from "takosumi-contract";
import {
  ControlApiError,
  type CapsuleCompatibilityDiagnostic,
  type CapsuleCompatibilityLevel,
  type CapsuleCompatibilityResult,
  type InstallConfig,
  type RunStatus,
} from "../../lib/control-api.ts";
import {
  hasInstallPrefillParams,
  isSafeInstallVariableValue,
} from "../../lib/install-link.ts";
import { t } from "../../i18n/index.ts";
import type { TcsListing } from "../../lib/tcs-client.ts";
import type { Tone } from "../../components/ui/index.ts";
import { readableProviderSourceLabel } from "../../lib/provider-labels.ts";

type StepState = "idle" | "running" | "done" | "error";
type FlowRun = {
  readonly id: number;
  readonly controller: AbortController;
};
type SourceAccessMode = "public" | "existing" | "token";

interface ProviderConnectionRow {
  readonly provider: string;
  readonly moduleLocalName: string;
  readonly childAlias: string;
  readonly rootAlias: string;
  readonly connectionId: string;
  readonly credentialRequired: boolean;
}

interface InputVariableRow {
  readonly name: string;
  readonly value: string;
  readonly jsonValue?: JsonValue;
}

interface EnvVariableRow {
  readonly name: string;
  readonly value: string;
}

type StoreMetadata = NonNullable<InstallConfig["store"]>;

const DEFAULT_STORE_BADGE = {
  ja: "追加候補",
  en: "Installable",
} satisfies StoreMetadata["badge"];

const CAPSULE_NAME_PATTERN = /^[a-z0-9-]+$/u;
const CAPSULE_DONE: StepState = "done";

type StoreEntry = NonNullable<InstallConfig["store"]> & {
  readonly id: string;
  readonly installConfigId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source: NonNullable<NonNullable<InstallConfig["store"]>["source"]>;
  readonly inputs: NonNullable<InstallConfig["variablePresentation"]>;
  readonly installExperience?: InstallConfig["installExperience"];
  /**
   * A legacy or malformed API row must not crash the Store screen or silently
   * become a raw-variable form. The compatibility endpoint reports repository
   * compiler failures separately; this flag covers only an invalid public
   * InstallConfig projection received by the dashboard.
   */
  readonly setupProjectionInvalid?: boolean;
  /**
   * Store-listing presentation only. Publisher identity comes from the Store
   * node, never from the InstallConfig, and never grants install authority.
   */
  readonly publisher?: TcsListing["publisher"];
};
type StoreInputField = StoreEntry["inputs"][number];
type StoreInstallFeature = NonNullable<
  NonNullable<InstallConfig["installExperience"]>["features"]
>[number];
type StoreAuthMode = "oidc" | "password";

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function localizedStoreText(
  value: unknown,
  fallback: string,
): { readonly ja: string; readonly en: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ja: fallback, en: fallback };
  }
  const record = value as Readonly<Record<string, unknown>>;
  const ja = safeText(record.ja);
  const en = safeText(record.en);
  return {
    ja: ja || en || fallback,
    en: en || ja || fallback,
  };
}

function storeInputLabel(field: StoreInputField, locale: "ja" | "en"): string {
  return localizedStoreText(field.label, field.name)[locale];
}

function storeInputHelper(
  field: StoreInputField,
  locale: "ja" | "en",
): string | undefined {
  const value = localizedStoreText(field.helper, "")[locale];
  return value || undefined;
}

function storeFeatureLabel(
  feature: StoreInstallFeature,
  locale: "ja" | "en",
): string {
  return localizedStoreText(feature.label, feature.id)[locale];
}

function compatibilityTone(level: CapsuleCompatibilityLevel): Tone {
  switch (level) {
    case "ready":
      return "ok";
    case "needs_patch":
      return "warn";
    case "unsupported":
      return "danger";
  }
}

function compatibilityLabel(level: CapsuleCompatibilityLevel): string {
  switch (level) {
    case "ready":
      return t("new.compat.ready");
    case "needs_patch":
      return t("new.compat.patch");
    case "unsupported":
      return t("new.compat.unsupported");
  }
}

function providerNameFromDiagnostic(
  diagnostic: CapsuleCompatibilityDiagnostic,
): string {
  return diagnostic.context?.provider ?? "provider";
}

function providerDisplayName(provider: string): string {
  return readableProviderSourceLabel(provider);
}

function compatibilityDiagnosticDisplay(
  diagnostic: CapsuleCompatibilityDiagnostic,
): {
  readonly message: string;
  readonly detail?: string;
  readonly technical?: boolean;
} {
  const provider = providerDisplayName(providerNameFromDiagnostic(diagnostic));
  const code = diagnostic.code;
  if (isRepositoryInstallUxDiagnostic(diagnostic)) {
    return {
      message: t("new.compat.issue.installUxInvalid.message"),
      detail: t("new.compat.issue.installUxInvalid.detail"),
    };
  }
  if (code === "provider_credentials_in_source") {
    return {
      message: t("new.compat.issue.providerCredentials.message", {
        provider,
      }),
      detail: t("new.compat.issue.providerCredentials.detail", { provider }),
    };
  }
  if (code === "provider_configuration_preserved") {
    return {
      message: t("new.compat.issue.providerPreserved.message", { provider }),
    };
  }
  if (code === "backend_state_isolated") {
    return { message: t("new.compat.issue.backendIsolated.message") };
  }
  if (code === "dependency_lock_detected") {
    return { message: t("new.compat.issue.lockfile.message") };
  }
  return {
    message: t("new.compat.issue.reviewRequired.message"),
    detail: diagnostic.detail || diagnostic.message,
    technical: true,
  };
}

function compatibilitySummaryDisplay(
  result: CapsuleCompatibilityResult,
): string {
  if (result.diagnostics.some(isRepositoryInstallUxDiagnostic)) {
    return t("new.compat.summary.installUxInvalid");
  }
  const credentialDiagnostic = result.diagnostics.find(
    (diagnostic) => diagnostic.code === "provider_credentials_in_source",
  );
  if (credentialDiagnostic) {
    return t("new.compat.summary.providerCredentials", {
      provider: providerDisplayName(
        providerNameFromDiagnostic(credentialDiagnostic),
      ),
    });
  }
  return t("new.compat.summary.reviewRequired");
}

function compatibilityCheckLooksTransient(
  result: CapsuleCompatibilityResult,
): boolean {
  return (
    result.level !== "ready" &&
    result.diagnostics.some(
      (diagnostic) => diagnostic.code === "capsule_compatibility_check_failed",
    )
  );
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new DOMException("Request was aborted.", "AbortError"),
    );
  }
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(resolve, ms);
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      reject(new DOMException("Request was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function sourceFetchErrorMessage(
  apiError: ControlApiError | undefined,
): string {
  const message = safeText(apiError?.message);
  const refMatch = /source ref did not resolve to a commit:\s*([^\s)]+)/iu.exec(
    message,
  );
  if (refMatch?.[1]) {
    return t("new.error.sourceRefNotFound", { ref: refMatch[1] });
  }
  return t("new.error.sourceFetchFailed", {
    message: message || t("new.error.sourceFetchFailedUnknown"),
  });
}

function safeControlApiErrorMessage(
  apiError: ControlApiError | undefined,
): string | undefined {
  if (apiError?.isAppHostnameUnavailable || apiError?.isDuplicateService) {
    return undefined;
  }
  const message = safeText(apiError?.message).replace(/\s+/gu, " ");
  if (!message) return undefined;
  // Generic API bucket phrases ("internal error", "invalid request") explain
  // nothing — showing them as 詳細 reads as a raw leak. Fall back to the
  // plain generic sentence instead.
  if (/^(internal error|invalid request|not found)$/iu.test(message)) {
    return undefined;
  }
  if (/\balready claimed by Capsule\b.*\bWorkspace\b/iu.test(message)) {
    return undefined;
  }
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

function addFlowErrorMessage(apiError: ControlApiError | undefined): string {
  if (apiError?.isAppHostnameUnavailable) {
    return t("new.error.appHostnameUnavailable");
  }
  if (apiError?.isManagedPublicHostnameSlotLimitReached) {
    return t("new.error.managedHostnameSlotLimit");
  }
  if (apiError?.isDuplicateService) {
    return t("new.error.alreadyExistsGeneric");
  }
  if (apiError?.reason === "provider_connection_setup_required") {
    return t("new.error.connectionRequired");
  }
  // Scoped managed hosts: the slug + workspace handle exceeded the hostname
  // budget — ask for a shorter name instead of the raw English sentence.
  if (apiError?.reason === "invalid_app_hostname") {
    return t("new.error.invalidHostname");
  }
  const message = safeControlApiErrorMessage(apiError);
  return message
    ? t("new.error.genericWithDetails", { message })
    : t("new.error.generic");
}

function shouldShowCompatibilityPanel(
  result: CapsuleCompatibilityResult,
): boolean {
  return result.level !== "ready" || result.diagnostics.length > 0;
}

function isFullCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/iu.test(value.trim());
}

function refInputValue(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return isFullCommitSha(trimmed) ? trimmed.slice(0, 8) : trimmed;
}

function displayRef(value: string | undefined): string {
  return refInputValue(value) || t("new.git.defaultRef");
}

function sourceHostLabel(value: string): string {
  try {
    const url = new URL(value.trim());
    return url.hostname.replace(/^www\./iu, "");
  } catch {
    return value.trim() || "-";
  }
}

function displayModulePath(value: string): string {
  return value.trim().replace(/^\/+|\/+$/gu, "") || ".";
}

function normalizeGitUrl(value: string): string {
  return normalizeInstallConfigSourceUrl(value);
}

function sameGitUrl(a: string, b: string): boolean {
  return normalizeGitUrl(a) === normalizeGitUrl(b);
}

function normalizeSourcePath(value: string): string {
  return normalizeInstallConfigSourcePath(value);
}

function slugInputValue(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "capsule"
  );
}

function uniqueServiceIdCandidate(value: string): string {
  const suffix = Math.random().toString(36).slice(2, 6) || "next";
  const base =
    slugInputValue(value)
      .replace(/^[^a-z]+/u, "")
      .slice(0, 48 - suffix.length - 1)
      .replace(/-+$/u, "") || "app";
  return `${base}-${suffix}`;
}

function managedServiceLabel(
  workspaceHandle: string | undefined,
  serviceSlug: string,
): string {
  // Handle not loaded yet → no label: a preview or submitted host must never
  // bake a placeholder prefix that differs from the server's real handle.
  if (!workspaceHandle) return "";
  const workspace = slugInputValue(workspaceHandle);
  const service = slugInputValue(serviceSlug);
  if (service.startsWith(`${workspace}-`)) return service.slice(0, 63);
  const maxServiceLength = Math.max(1, 62 - workspace.length);
  return `${workspace}-${service.slice(0, maxServiceLength).replace(/-+$/u, "")}`;
}

function publicEndpointHost(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.hostname.toLowerCase() : "";
  } catch {
    return undefined;
  }
}

function hostIsManagedBaseDomainSubdomain(
  host: string,
  baseDomain: string,
): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedBase = baseDomain.toLowerCase();
  if (!normalizedHost.endsWith(`.${normalizedBase}`)) return false;
  const prefix = normalizedHost.slice(
    0,
    normalizedHost.length - normalizedBase.length - 1,
  );
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(prefix);
}

function isManagedSubdomainLabel(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value.trim());
}

function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/iu.test(value.trim());
}

function storeInputKey(entryId: string, fieldName: string): string {
  return `${entryId}:${fieldName}`;
}

function storePublicEndpoint(entry: StoreEntry) {
  const projections = entry.installExperience?.projections;
  if (!Array.isArray(projections)) return undefined;
  const projection = projections.find(
    (candidate) => candidate?.kind === "public_endpoint",
  );
  if (
    projection?.kind !== "public_endpoint" ||
    !projection.variables ||
    typeof projection.variables !== "object"
  ) {
    return undefined;
  }
  const subdomainVariable = safeText(projection.variables.subdomain);
  const urlVariable = safeText(projection.variables.url);
  const routePatternVariable = safeText(projection.variables.routePattern);
  const baseDomain = safeText(projection.baseDomain);
  if (!subdomainVariable && !urlVariable && !routePatternVariable) {
    return undefined;
  }
  return {
    ...(subdomainVariable ? { subdomainVariable } : {}),
    ...(urlVariable ? { urlVariable } : {}),
    ...(routePatternVariable ? { routePatternVariable } : {}),
    ...(baseDomain ? { baseDomain } : {}),
  };
}

function storeEndpointField(
  entry: StoreEntry,
  name: string | undefined,
): StoreInputField | undefined {
  const normalized = name?.trim();
  return normalized
    ? entry.inputs.find((field) => field.name === normalized)
    : undefined;
}

function storePublicEndpointSubdomainField(
  entry: StoreEntry,
): StoreInputField | undefined {
  return storeEndpointField(
    entry,
    storePublicEndpoint(entry)?.subdomainVariable,
  );
}

function storeServiceNameVariable(
  store: Pick<StoreEntry, "installExperience">,
): string | undefined {
  const projections = store.installExperience?.projections;
  if (!Array.isArray(projections)) return undefined;
  const projection = projections.find(
    (candidate) => candidate?.kind === "service_name",
  );
  if (projection?.kind !== "service_name") return undefined;
  return safeText(projection.variable) || undefined;
}

function storeServiceNameField(entry: StoreEntry): StoreInputField | undefined {
  const variable = storeServiceNameVariable(entry);
  return variable
    ? entry.inputs.find((field) => field.name === variable)
    : undefined;
}

function isStorePublicEndpointField(
  entry: StoreEntry,
  field: StoreInputField,
): boolean {
  const endpoint = storePublicEndpoint(entry);
  return (
    field.name === endpoint?.subdomainVariable ||
    field.name === endpoint?.urlVariable ||
    field.name === endpoint?.routePatternVariable
  );
}

function storeInitialSecretField(
  entry: StoreEntry,
): StoreInputField | undefined {
  const projections = entry.installExperience?.projections;
  if (!Array.isArray(projections)) return undefined;
  const projection = projections.find(
    (candidate) => candidate?.kind === "initial_secret",
  );
  if (projection?.kind !== "initial_secret") return undefined;
  const variable = safeText(projection.variable);
  return variable
    ? entry.inputs.find((field) => field.name === variable)
    : undefined;
}

function storeSupportsOidc(entry: StoreEntry): boolean {
  const projections = entry.installExperience?.projections;
  if (!Array.isArray(projections)) return false;
  return projections.some((projection) => {
    if (
      projection?.kind !== "oidc_client" ||
      !projection.variables ||
      typeof projection.variables !== "object"
    ) {
      return false;
    }
    const callbackPath = safeText(projection.callbackPath);
    return (
      callbackPath.startsWith("/") &&
      !callbackPath.startsWith("//") &&
      !callbackPath.includes("://")
    );
  });
}

function defaultStoreAuthMode(entry: StoreEntry): StoreAuthMode | undefined {
  if (storeSupportsOidc(entry)) return "oidc";
  return storeInitialSecretField(entry) ? "password" : undefined;
}

function storeInstallFeatures(
  entry: StoreEntry,
): readonly StoreInstallFeature[] {
  const features = entry.installExperience?.features;
  if (!Array.isArray(features)) return [];
  return features.filter((feature) =>
    Boolean(
      feature &&
      safeText(feature.id) &&
      Array.isArray(feature.inputs) &&
      feature.inputs.every((name: unknown) => Boolean(safeText(name))),
    ),
  );
}

function storeFeatureInputNames(entry: StoreEntry): ReadonlySet<string> {
  return new Set(
    storeInstallFeatures(entry).flatMap((feature) =>
      feature.inputs.map((name) => safeText(name)).filter(Boolean),
    ),
  );
}

function storeFeatureInputs(
  entry: StoreEntry,
  feature: StoreInstallFeature,
): readonly StoreInputField[] {
  const names = new Set(feature.inputs.map(safeText).filter(Boolean));
  return entry.inputs.filter((field) => names.has(field.name));
}

function storeInputIsDerived(field: StoreInputField): boolean {
  return (
    field.defaultValue?.source === "capsule_name" ||
    field.defaultValue?.source === "workspace_scoped_capsule_name"
  );
}

function storeUsesRepositoryInstallUx(entry: StoreEntry): boolean {
  return entry.installExperience?.repositoryInstallUx?.status === "accepted";
}

function isRepositoryInstallUxDiagnostic(
  diagnostic: CapsuleCompatibilityDiagnostic,
): boolean {
  return diagnostic.code === "repository_install_ux_invalid";
}

const DEFAULT_CAPSULE_INSTALL_CONFIG_ID = "cfg-default-opentofu-capsule";

function storeDefaultInputValue(
  entry: StoreEntry,
  field: StoreInputField,
  workspaceHandle: string | undefined,
  serviceSlug?: string,
  managedPublicBaseDomain?: string,
  managedPublicHostnameMode: "scoped" | "vanity" = "scoped",
): string {
  const base = slugInputValue(entry.suggestedName);
  const requestedServiceSlug = slugInputValue(serviceSlug || base);
  const scopedServiceSlug = managedServiceLabel(
    workspaceHandle,
    requestedServiceSlug,
  );
  const publicEndpoint = storePublicEndpoint(entry);
  if (field.name === publicEndpoint?.subdomainVariable) {
    return requestedServiceSlug;
  }
  if (
    field.name === publicEndpoint?.urlVariable &&
    (managedPublicBaseDomain || publicEndpoint.baseDomain)
  ) {
    // Normalize the operator/listing-owned base domain (strip wildcard and
    // trailing dot) exactly like the control plane.
    const publicServiceSlug =
      managedPublicHostnameMode === "vanity"
        ? requestedServiceSlug
        : scopedServiceSlug;
    const baseDomain = managedBaseDomain(
      managedPublicBaseDomain ?? publicEndpoint.baseDomain,
    );
    return publicServiceSlug && baseDomain
      ? `https://${publicServiceSlug}.${baseDomain}`
      : "";
  }
  switch (field.defaultValue?.source) {
    case "capsule_name":
      return requestedServiceSlug;
    case "workspace_scoped_capsule_name":
      return scopedServiceSlug;
    case "literal":
      return installVariableDisplayValue(field.defaultValue.value);
    default:
      return "";
  }
}

function serviceNameHintIsGenerated(
  value: StoreInputField["defaultValue"],
): boolean {
  return (
    value?.source === "capsule_name" ||
    value?.source === "workspace_scoped_capsule_name"
  );
}

function storeVariablePath(name: string): readonly string[] | undefined {
  const path = name.split(".").map((part) => part.trim());
  if (path.length === 0) return undefined;
  return path.every(isSafeStoreVariablePathSegment) ? path : undefined;
}

function isSafeStoreVariablePathSegment(value: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) &&
    value !== "__proto__" &&
    value !== "constructor" &&
    value !== "prototype"
  );
}

function storeInputJsonValue(
  field: StoreInputField,
  raw: string,
): JsonValue | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (field.type === "boolean") {
    const normalized = value.toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  if (field.type === "number") {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  if (field.type === "json") {
    const parsed = parseStoreJsonValue(value);
    if (parsed !== undefined) return parsed;
  }
  return value;
}

function parseStoreJsonValue(value: string): JsonValue | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return isSafeStoreJsonValue(parsed) ? parsed : undefined;
}

function isSafeStoreJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false;
  if (value === null) return true;
  switch (typeof value) {
    case "string":
      return isSafeInstallVariableValue(value);
    case "number":
      return Number.isFinite(value);
    case "boolean":
      return true;
    case "object":
      if (Array.isArray(value)) {
        return (
          value.length <= 64 &&
          value.every((item) => isSafeStoreJsonValue(item, depth + 1))
        );
      }
      return Object.entries(value as Record<string, unknown>).every(
        ([key, nested]) =>
          isSafeStoreVariablePathSegment(key) &&
          isSafeStoreJsonValue(nested, depth + 1),
      );
    default:
      return false;
  }
}

function setStoreJsonVariable(
  target: Record<string, JsonValue>,
  name: string,
  value: JsonValue,
): void {
  const path = storeVariablePath(name);
  if (!path) return;
  let cursor = target;
  for (const segment of path.slice(0, -1)) {
    const existing = cursor[segment];
    const next = isJsonRecord(existing) ? { ...existing } : {};
    cursor[segment] = next;
    cursor = next;
  }
  cursor[path[path.length - 1]!] = value;
}

function isJsonRecord(
  value: JsonValue | undefined,
): value is Record<string, JsonValue> {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function installVariableDisplayValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function routePatternFromAppUrl(
  value: JsonValue | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || !url.hostname) return undefined;
    return `${url.hostname}/*`;
  } catch {
    return undefined;
  }
}

function managedBaseDomain(value: string | undefined): string | undefined {
  const trimmed = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\*\./u, "")
    .replace(/\.$/u, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
    trimmed,
  )
    ? trimmed
    : undefined;
}

function isSafePlainEnvName(name: string): boolean {
  const trimmed = name.trim();
  return /^[A-Z_][A-Z0-9_]{0,127}$/u.test(trimmed);
}

function storeKindFromStoreListing(
  kind: TcsListing["kind"],
): StoreMetadata["kind"] {
  return safeStoreToken(kind) ?? "other";
}

function storeSurfaceFromStoreListing(
  surface: TcsListing["surface"],
): StoreMetadata["surface"] {
  return safeStoreToken(surface) ?? "service";
}

function safeStoreToken(value: unknown): string | undefined {
  const trimmed = safeText(value);
  return trimmed && /^[A-Za-z0-9_.:-]{1,128}$/u.test(trimmed)
    ? trimmed
    : undefined;
}

function nonEmptyStoreText(value: unknown): StoreMetadata["badge"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const ja = safeText(record.ja);
  const en = safeText(record.en);
  return ja || en ? { ja: ja || en, en: en || ja } : undefined;
}

function storeSourceMatchesListing(
  source: StoreMetadata["source"],
  listing: TcsListing,
): boolean {
  return storeSourceMatchesCoordinate(source, listing.source.url);
}

function storeSourceMatchesCoordinate(
  source: StoreMetadata["source"],
  url: string,
  _legacyPath?: string,
): boolean {
  // Store metadata is a presentation/eligibility overlay. Its URL may help
  // identify the host-owned row, but its legacy path is never an executable
  // coordinate and is intentionally ignored here.
  const sourceUrl =
    typeof source?.url === "string" ? source.url.trim() : undefined;
  const candidateUrl = safeText(url);
  return Boolean(
    sourceUrl &&
      candidateUrl &&
      normalizeInstallConfigSourceUrl(sourceUrl) ===
        normalizeInstallConfigSourceUrl(candidateUrl),
  );
}

function storeInstallConfigsForSource(
  configs: readonly InstallConfig[],
  url: string,
  _legacyPath?: string,
): readonly InstallConfig[] {
  const candidateUrl = safeText(url);
  if (!candidateUrl) return [];
  return configs.filter((config) => {
    // A generic Git config can share the same Source URL. It is not a Store
    // overlay and must never be selected just because a listing mentions that
    // repository. Store eligibility is explicit in the host-owned metadata.
    if (!config.store) return false;
    const selectorUrl = safeText(config.sourceSelector?.url);
    if (!selectorUrl || !storeSourceMatchesCoordinate(config.store.source, selectorUrl)) {
      return false;
    }
    return storeSourceMatchesCoordinate(config.store.source, candidateUrl);
  });
}

/**
 * Store navigation may resolve exactly one explicitly Store-eligible,
 * service-owned InstallConfig by repository URL. Direct Git imports keep their
 * independent URL/path selector; a Store listing may never choose that generic
 * row or use its own (legacy) path as an executable hint.
 */
function uniqueStoreInstallConfigForSource(
  configs: readonly InstallConfig[],
  url: string,
  _legacyPath?: string,
): InstallConfig | null {
  const matches = storeInstallConfigsForSource(configs, url);
  return matches.length === 1 ? matches[0]! : null;
}

function storeMetadataFromStoreListing(listing: TcsListing): StoreMetadata {
  const suggestedName = safeText(listing.suggestedName) || "service";
  const fallbackName = {
    ja: suggestedName,
    en: suggestedName,
  };
  return {
    // `InstallConfigStoreSource.path` exists in older control-plane rows. Keep
    // the runtime projection URL-only so no Store path can leak into an
    // install handoff; the cast lets this dashboard read those old rows while
    // the contract migrates.
    source: { url: listing.source.url } as StoreMetadata["source"],
    order: 1_000,
    surface: storeSurfaceFromStoreListing(listing.surface),
    kind: storeKindFromStoreListing(listing.kind),
    provider: safeText(listing.provider) || "provider",
    suggestedName,
    badge: nonEmptyStoreText(listing.badge) ?? DEFAULT_STORE_BADGE,
    name: nonEmptyStoreText(listing.name) ?? fallbackName,
    description: nonEmptyStoreText(listing.description) ?? fallbackName,
    ...(listing.iconUrl ? { iconUrl: listing.iconUrl } : {}),
  };
}

function normalizedStoreInputs(value: InstallConfig["variablePresentation"]): {
  readonly inputs: NonNullable<InstallConfig["variablePresentation"]>;
  readonly invalid: boolean;
} {
  if (value === undefined) return { inputs: [], invalid: false };
  if (!Array.isArray(value)) return { inputs: [], invalid: true };
  const inputs: StoreInputField[] = [];
  let invalid = false;
  for (const candidate of value as readonly unknown[]) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      invalid = true;
      continue;
    }
    const record = candidate as Readonly<Record<string, unknown>>;
    const name = safeText(record.name);
    const type = safeText(record.type);
    if (
      !name ||
      !storeVariablePath(name) ||
      (type && !["string", "number", "boolean", "json"].includes(type))
    ) {
      invalid = true;
      continue;
    }
    const label = nonEmptyStoreText(record.label);
    if (!label) invalid = true;
    const helper = nonEmptyStoreText(record.helper);
    const placeholder = safeText(record.placeholder);
    const format = safeText(record.format);
    inputs.push({
      ...(candidate as StoreInputField),
      name,
      ...(type ? { type: type as NonNullable<StoreInputField["type"]> } : {}),
      ...(format ? { format } : {}),
      label: label ?? { ja: name, en: name },
      ...(helper ? { helper } : {}),
      ...(placeholder ? { placeholder } : {}),
    });
  }
  return { inputs, invalid };
}

function storeEntryIdFromStoreListing(listing: TcsListing): string {
  return `store:${safeStoreToken(listing.id) ?? slugInputValue(listing.suggestedName)}`;
}

function storeEntryFromStoreListing(
  listing: TcsListing,
  installConfig: InstallConfig,
): StoreEntry {
  const store = storeMetadataFromStoreListing(listing);
  const normalizedInputs = normalizedStoreInputs(
    installConfig.variablePresentation,
  );
  return {
    id: storeEntryIdFromStoreListing(listing),
    installConfigId: installConfig.id,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
    ...store,
    inputs: normalizedInputs.inputs,
    ...(installConfig.installExperience
      ? { installExperience: installConfig.installExperience }
      : {}),
    ...(normalizedInputs.invalid ? { setupProjectionInvalid: true } : {}),
    ...(listing.publisher ? { publisher: listing.publisher } : {}),
    source: {
      url:
        typeof store.source?.url === "string" && store.source.url.trim()
          ? store.source.url.trim()
          : listing.source.url,
    } as StoreEntry["source"],
  };
}

function sourceIdFromControlError(error: ControlApiError | undefined): string {
  const body = error?.body;
  if (body && typeof body === "object" && "sourceId" in body) {
    const value = (body as { readonly sourceId?: unknown }).sourceId;
    return typeof value === "string" ? value : "";
  }
  return "";
}

function isDuplicateServiceError(error: ControlApiError | undefined): boolean {
  return error?.isDuplicateService ?? false;
}

function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case "queued":
      return t("status.run.queued");
    case "running":
      return t("status.run.running");
    case "waiting_approval":
      return t("status.run.waiting_approval");
    case "succeeded":
      return t("status.run.succeeded");
    case "failed":
      return t("status.run.failed");
    case "cancelled":
      return t("status.run.cancelled");
    case "expired":
      return t("status.run.expired");
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function defaultWorkspaceHandle(): string {
  const time = Date.now().toString(36).slice(-6);
  const random = Math.random().toString(36).slice(2, 8) || "new";
  return `workspace-${time}-${random}`.slice(0, 39);
}

function parseInitialTcsHandoff(
  search: string,
): { readonly base: string; readonly listingId: string } | null {
  const params = new URLSearchParams(search);
  const base = params.get("tcsBase")?.trim();
  const listingId = params.get("tcsListing")?.trim();
  if (!base || !listingId || !/^[A-Za-z0-9_.:@/-]{1,256}$/u.test(listingId)) {
    return null;
  }
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    url.search = "";
    return {
      base: url.toString().replace(/\/+$/u, ""),
      listingId,
    };
  } catch {
    return null;
  }
}

function initialAddTab(search: string): "store" | "git" {
  // Start on the service browser. Install links and pasted source links enter
  // the same flow after a source is selected.
  return parseInitialTcsHandoff(search) || !hasInstallPrefillParams(search)
    ? "store"
    : "git";
}

export type {
  StepState,
  FlowRun,
  SourceAccessMode,
  ProviderConnectionRow,
  InputVariableRow,
  EnvVariableRow,
  StoreMetadata,
  StoreEntry,
  StoreInputField,
  StoreInstallFeature,
  StoreAuthMode,
};
export {
  DEFAULT_STORE_BADGE,
  CAPSULE_NAME_PATTERN,
  CAPSULE_DONE,
  compatibilityTone,
  compatibilityLabel,
  providerNameFromDiagnostic,
  providerDisplayName,
  compatibilityDiagnosticDisplay,
  compatibilitySummaryDisplay,
  compatibilityCheckLooksTransient,
  isRepositoryInstallUxDiagnostic,
  abortableDelay,
  sourceFetchErrorMessage,
  safeControlApiErrorMessage,
  addFlowErrorMessage,
  shouldShowCompatibilityPanel,
  isFullCommitSha,
  refInputValue,
  displayRef,
  sourceHostLabel,
  displayModulePath,
  normalizeGitUrl,
  sameGitUrl,
  normalizeSourcePath,
  slugInputValue,
  uniqueServiceIdCandidate,
  managedServiceLabel,
  publicEndpointHost,
  hostIsManagedBaseDomainSubdomain,
  isManagedSubdomainLabel,
  isSha256Hex,
  storeInputKey,
  storePublicEndpoint,
  storeEndpointField,
  storePublicEndpointSubdomainField,
  storeServiceNameVariable,
  storeServiceNameField,
  storeInitialSecretField,
  storeSupportsOidc,
  defaultStoreAuthMode,
  storeInstallFeatures,
  storeFeatureInputNames,
  storeFeatureInputs,
  storeInputIsDerived,
  storeUsesRepositoryInstallUx,
  storeInputLabel,
  storeInputHelper,
  storeFeatureLabel,
  localizedStoreText,
  isStorePublicEndpointField,
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  storeDefaultInputValue,
  serviceNameHintIsGenerated,
  storeVariablePath,
  isSafeStoreVariablePathSegment,
  storeInputJsonValue,
  parseStoreJsonValue,
  isSafeStoreJsonValue,
  setStoreJsonVariable,
  isJsonRecord,
  installVariableDisplayValue,
  routePatternFromAppUrl,
  managedBaseDomain,
  isSafePlainEnvName,
  storeKindFromStoreListing,
  storeSurfaceFromStoreListing,
  safeStoreToken,
  nonEmptyStoreText,
  storeSourceMatchesListing,
  storeSourceMatchesCoordinate,
  storeInstallConfigsForSource,
  uniqueStoreInstallConfigForSource,
  storeMetadataFromStoreListing,
  storeEntryIdFromStoreListing,
  storeEntryFromStoreListing,
  sourceIdFromControlError,
  isDuplicateServiceError,
  runStatusLabel,
  isAbortError,
  defaultWorkspaceHandle,
  parseInitialTcsHandoff,
  initialAddTab,
};
