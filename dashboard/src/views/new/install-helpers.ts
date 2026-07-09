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
  readonly resourceTypes: readonly string[];
  readonly rootModuleVariables: readonly string[];
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

const INSTALLATION_NAME_PATTERN = /^[a-z0-9-]+$/u;
const INSTALLATION_DONE: StepState = "done";

type StoreEntry = NonNullable<InstallConfig["store"]> & {
  readonly id: string;
  readonly installConfigId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source: NonNullable<NonNullable<InstallConfig["store"]>["source"]>;
};
type StoreInputField = StoreEntry["inputs"][number];

function compatibilityTone(level: CapsuleCompatibilityLevel): Tone {
  switch (level) {
    case "ready":
    case "auto_capsulized":
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
    case "auto_capsulized":
      return t("new.compat.auto");
    case "needs_patch":
      return t("new.compat.patch");
    case "unsupported":
      return t("new.compat.unsupported");
  }
}

function providerNameFromDiagnostic(
  diagnostic: CapsuleCompatibilityDiagnostic,
): string {
  const match =
    /^Provider\s+([a-zA-Z0-9_.-]+)\s+(?:contains|can be lifted)/u.exec(
      diagnostic.message,
    );
  return match?.[1] ?? "provider";
}

function providerDisplayName(provider: string): string {
  const normalized = provider.toLowerCase();
  switch (normalized) {
    case "aws":
      return "AWS";
    case "cloudflare":
      return "Cloudflare";
    case "google":
      return "Google Cloud";
    case "hcloud":
      return "Hetzner Cloud";
    default:
      return provider;
  }
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
  if (
    code === "provider_credentials_in_source" ||
    /^Provider\s+[a-zA-Z0-9_.-]+\s+contains credential-like attributes\.?$/u.test(
      diagnostic.message,
    )
  ) {
    return {
      message: t("new.compat.issue.providerCredentials.message", {
        provider,
      }),
      detail: t("new.compat.issue.providerCredentials.detail", { provider }),
    };
  }
  if (
    code === "provider_block_lift_candidate" ||
    /^Provider\s+[a-zA-Z0-9_.-]+\s+can be lifted into the generated root/u.test(
      diagnostic.message,
    )
  ) {
    return {
      message: t("new.compat.issue.providerLift.message", { provider }),
    };
  }
  if (
    code === "dependency_lock_detected" ||
    diagnostic.message ===
      "A provider dependency lockfile is present and will be reviewed by the provider lockfile policy after credential-free init."
  ) {
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
    (diagnostic) =>
      diagnostic.code === "provider_credentials_in_source" ||
      /^Provider\s+[a-zA-Z0-9_.-]+\s+contains credential-like attributes\.?$/u.test(
        diagnostic.message,
      ),
  );
  if (
    credentialDiagnostic &&
    /^Provider\s+[a-zA-Z0-9_.-]+\s+contains credential-like attributes\.?$/u.test(
      result.summary,
    )
  ) {
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
  if (result.level === "ready" || result.level === "auto_capsulized") {
    return false;
  }
  const text = [
    result.summary,
    ...result.diagnostics.flatMap((diagnostic) => [
      diagnostic.code ?? "",
      diagnostic.message,
      diagnostic.detail ?? "",
    ]),
  ]
    .join("\n")
    .toLowerCase();
  return (
    (text.includes("retry") && text.includes("source sync")) ||
    text.includes("operation was aborted") ||
    text.includes("compatibility_check runner")
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
  if (/\balready claimed by Capsule\b.*\bWorkspace\b/iu.test(message)) {
    return undefined;
  }
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

function addFlowErrorMessage(apiError: ControlApiError | undefined): string {
  if (apiError?.isAppHostnameUnavailable) {
    return t("new.error.appHostnameUnavailable");
  }
  if (apiError?.isDuplicateService) {
    return t("new.error.alreadyExistsGeneric");
  }
  // The controller's "provider connection is required for providers: …" is an
  // internal sentence — a general user gets the friendly connection ask.
  if (/provider connection is required/iu.test(apiError?.message ?? "")) {
    return t("new.error.connectionRequired");
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

function workspaceSuffix(value: string | null): string {
  return (value ?? "")
    .replace(/^workspace_/u, "")
    .replace(/[^a-z0-9-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 6)
    .toLowerCase();
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
  store: Pick<StoreEntry, "installExperience"> | StoreMetadata,
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
  workspaceId: string | null,
  serviceSlug?: string,
): string {
  const base = slugInputValue(entry.suggestedName);
  const suffix = workspaceSuffix(workspaceId);
  const scopedServiceSlug =
    serviceSlug || (suffix ? `${base}-${suffix}` : base);
  const publicEndpoint = storePublicEndpoint(entry);
  if (field.name === publicEndpoint?.subdomainVariable) {
    return scopedServiceSlug;
  }
  if (field.name === publicEndpoint?.urlVariable && publicEndpoint.baseDomain) {
    return `https://${scopedServiceSlug}.${publicEndpoint.baseDomain}`;
  }
  switch (field.defaultValue) {
    case "service-name":
      return base;
    case "service-name-with-space":
      return scopedServiceSlug;
    case "main":
      return "main";
    case "us-east-1":
      return "us-east-1";
    default:
      return field.defaultValue ?? "";
  }
}

function serviceNameHintIsGenerated(value: string | undefined): boolean {
  return value === "service-name" || value === "service-name-with-space";
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

function managedBaseDomain(value: string | undefined): string {
  const trimmed = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\*\./u, "")
    .replace(/\.$/u, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(
    trimmed,
  )
    ? trimmed
    : "app.takos.jp";
}

function inputVariableRowsFromPrefill(
  vars: Readonly<Record<string, JsonValue>> | undefined,
): readonly InputVariableRow[] {
  return Object.entries(vars ?? {})
    .filter(([name]) => name !== "env")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({
      name,
      value: installVariableDisplayValue(value),
      ...(typeof value === "string" ? {} : { jsonValue: value }),
    }));
}

function envVariableRowsFromPrefill(
  vars: Readonly<Record<string, JsonValue>> | undefined,
): readonly EnvVariableRow[] {
  const env = vars?.env;
  if (!isJsonRecord(env)) return [];
  return Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, value }));
}

function isSafePlainEnvName(name: string): boolean {
  const trimmed = name.trim();
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(trimmed)) return false;
  return !/(SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_?KEY|API_?KEY)/iu.test(
    trimmed,
  );
}

function storeKindFromStoreListing(
  kind: TcsListing["kind"],
): StoreMetadata["kind"] {
  if (kind === "storage") return "storage";
  if (kind === "site") return "site";
  return "worker";
}

function storeSurfaceFromStoreListing(
  surface: TcsListing["surface"],
): StoreMetadata["surface"] {
  if (surface === "building_block") return "building_block";
  if (surface === "example") return "example";
  return "service";
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

function storeMetadataFromStoreListing(listing: TcsListing): StoreMetadata {
  const fallbackName = {
    ja: listing.suggestedName,
    en: listing.suggestedName,
  };
  return {
    source: {
      git: listing.source.git,
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
    inputs: [],
  };
}

function storeEntryIdFromStoreListing(listing: TcsListing): string {
  return `store:${safeStoreToken(listing.id) ?? slugInputValue(listing.suggestedName)}`;
}

function storeEntryFromStoreListing(
  listing: TcsListing,
  installConfigId: string,
): StoreEntry {
  const store = storeMetadataFromStoreListing(listing);
  return {
    id: storeEntryIdFromStoreListing(listing),
    installConfigId,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
    ...store,
    source: store.source ?? {
      git: listing.source.git,
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
  INSTALLATION_NAME_PATTERN,
  INSTALLATION_DONE,
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
  workspaceSuffix,
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
  inputVariableRowsFromPrefill,
  envVariableRowsFromPrefill,
  isSafePlainEnvName,
  storeKindFromStoreListing,
  storeSurfaceFromStoreListing,
  safeStoreToken,
  nonEmptyStoreText,
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
