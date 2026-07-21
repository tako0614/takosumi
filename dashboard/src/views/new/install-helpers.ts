/**
 * /new install flow — pure helpers (no JSX, no component state).
 *
 * Split out of NewAppView.tsx so the view file holds only the flow state
 * machine and rendering. Everything here is presentation-independent: store
 * listing → StoreEntry/metadata mapping, compatibility result display,
 * git/slug/url normalization, install-variable row plumbing, and the
 * store-input defaulting rules the one-tap install path relies on.
 */
import {
  installExperiencePublicEndpoint,
  installExperienceServiceNameVariable,
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
  readonly alias: string;
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
   * Store-listing presentation only. Publisher identity comes from the Store
   * node, never from the InstallConfig, and never grants install authority.
   */
  readonly publisher?: TcsListing["publisher"];
};
type StoreInputField = StoreEntry["inputs"][number];

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
  const message = apiError?.message.trim() ?? "";
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
  const message = apiError?.message.replace(/\s+/gu, " ").trim();
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
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\.git$/iu, "");
    return url.toString().replace(/\/+$/u, "").toLowerCase();
  } catch {
    return value
      .trim()
      .replace(/\/+$/u, "")
      .replace(/\.git$/iu, "")
      .toLowerCase();
  }
}

function sameGitUrl(a: string, b: string): boolean {
  return normalizeGitUrl(a) === normalizeGitUrl(b);
}

function normalizeSourcePath(value: string): string {
  return displayModulePath(value).replace(/^\.\//u, "");
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
  return installExperiencePublicEndpoint(entry.installExperience);
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
  return installExperienceServiceNameVariable(store.installExperience);
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

function safeStoreToken(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed && /^[A-Za-z0-9_.:-]{1,128}$/u.test(trimmed)
    ? trimmed
    : undefined;
}

function nonEmptyStoreText(
  value: StoreMetadata["badge"],
): StoreMetadata["badge"] | undefined {
  return value.ja.trim() && value.en.trim() ? value : undefined;
}

function storeSourceMatchesListing(
  source: StoreMetadata["source"],
  listing: TcsListing,
): boolean {
  return storeSourceMatchesCoordinate(
    source,
    listing.source.url,
    listing.source.path,
  );
}

function storeSourceMatchesCoordinate(
  source: StoreMetadata["source"],
  url: string,
  path: string,
): boolean {
  const sourceUrl = source?.url.trim();
  const sourcePath = source?.path.trim();
  return Boolean(
    sourceUrl &&
    sourcePath &&
    sameGitUrl(sourceUrl, url) &&
    normalizeSourcePath(sourcePath) === normalizeSourcePath(path),
  );
}

function storeInstallConfigsForSource(
  configs: readonly InstallConfig[],
  url: string,
  path: string,
): readonly InstallConfig[] {
  if (!url.trim()) return [];
  return configs.filter((config) =>
    storeSourceMatchesCoordinate(config.store?.source, url, path),
  );
}

function storeMetadataFromStoreListing(listing: TcsListing): StoreMetadata {
  const fallbackName = {
    ja: listing.suggestedName,
    en: listing.suggestedName,
  };
  return {
    source: {
      url: listing.source.url,
      path: listing.source.path || ".",
    },
    order: 1_000,
    surface: storeSurfaceFromStoreListing(listing.surface),
    kind: storeKindFromStoreListing(listing.kind),
    provider: listing.provider,
    suggestedName: listing.suggestedName,
    badge: nonEmptyStoreText(listing.badge) ?? DEFAULT_STORE_BADGE,
    name: nonEmptyStoreText(listing.name) ?? fallbackName,
    description: nonEmptyStoreText(listing.description) ?? fallbackName,
    ...(listing.iconUrl ? { iconUrl: listing.iconUrl } : {}),
  };
}

function storeEntryIdFromStoreListing(listing: TcsListing): string {
  return `store:${safeStoreToken(listing.id) ?? slugInputValue(listing.suggestedName)}`;
}

function storeEntryFromStoreListing(
  listing: TcsListing,
  installConfig: InstallConfig,
): StoreEntry {
  const store = storeMetadataFromStoreListing(listing);
  return {
    id: storeEntryIdFromStoreListing(listing),
    installConfigId: installConfig.id,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
    ...store,
    inputs: installConfig.variablePresentation ?? [],
    ...(installConfig.installExperience
      ? { installExperience: installConfig.installExperience }
      : {}),
    ...(listing.publisher ? { publisher: listing.publisher } : {}),
    source: store.source ?? {
      url: listing.source.url,
      path: listing.source.path || ".",
    },
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
