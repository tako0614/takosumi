/**
 * Request-body / query value coercion helpers for the session-authed `/api/v1`
 * control surface. Pure functions; extracted from `control-routes.ts` (P3
 * god-file split). NOTE: several coerce write-only credential material — never
 * log their return values.
 */
import type {
  ApplyExpectedGuard,
  ApplyRunResponse,
  Connection,
  ConnectionOAuthStartResponse,
  ConnectionResponse,
  ConnectionScopeHints,
  CreateApplyRunRequest,
  CreateConnectionFile,
  CreateConnectionRequest,
  DeployControlErrorCode,
  Deployment,
  InternalDeployRequest,
  ListConnectionsResponse,
  ListDeploymentsResponse,
  ListRunnerProfilesResponse,
  OpenTofuModuleSource,
  PlanRunResponse,
  PublicPlanRun,
  TestConnectionResponse,
} from "@takosumi/internal/deploy-control-api";
import type {
  ArtifactSnapshotRequest,
  Source,
  CreateSourceRequest,
  CreateSourceResponse,
  ListSourceSnapshotsResponse,
  ListSourcesResponse,
  PatchSourceRequest,
  SourceResponse,
  SourceSnapshot,
} from "takosumi-contract/sources";
import type {
  DeployResponse,
  PublicDeployResponse,
} from "takosumi-contract/deploy";
import type {
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
  PublicCapsuleCompatibilityReportResponse,
} from "takosumi-contract/capsules";
import type { ListProvidersResponse } from "takosumi-contract/providers";
import type { Workspace, WorkspaceType } from "takosumi-contract/workspaces";
import type {
  CapsuleProviderEnvBindingSet,
  InstallConfig,
  InstallConfigStoreInput,
  InstallConfigInstallExperience,
  InstallConfigInstallProjection,
  InstallConfigStoreKind,
  InstallConfigStoreMetadata,
  InstallConfigStoreSurface,
  InstallConfigStoreText,
  Capsule,
  OutputAllowlistEntry,
  PolicyConfig,
  PublicInstallConfig,
  PublicCapsule,
  SourceBuildConfig,
} from "takosumi-contract/install-configs";
import type {
  Dependency,
  DependencyMode,
  DependencyOutputMapping,
  DependencyVisibility,
} from "takosumi-contract/dependencies";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { Page, PageParams } from "takosumi-contract/pagination";
import type {
  CapsuleProviderConnectionBinding,
  CapsuleProviderConnectionBindings,
  CapsuleProviderEnvBinding,
  CapsuleProviderEnvBindings,
  CapsuleProviderConnectionSet,
  ProviderConnection,
} from "takosumi-contract/connections";
import type {
  ProviderResolution,
  PublicProviderResolution,
} from "takosumi-contract/provider-resolution";
import type { OutputShare, OutputShareEntry } from "takosumi-contract/outputs";
import type { PublicDeployment } from "takosumi-contract/deployments";
import type {
  BackupRecord,
  CreateBackupResponse,
  CreateRestoreRequest,
  ListBackupsResponse,
} from "takosumi-contract/backups";
import type {
  BillingSettings,
  CreditBalance,
  CreditReservation,
  UsageEvent,
} from "takosumi-contract/billing";
import type {
  ListRunsResponse,
  Run,
  RunCostInfo,
  RunEventsResponse,
  RunLogsResponse,
  PublicRun,
} from "takosumi-contract/runs";
import type { JsonValue } from "takosumi-contract";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { isAbsolute, normalize } from "node:path";
import { stringValue } from "../http-helpers.ts";

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function stringRecordValue(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return undefined;
    out[key] = item;
  }
  return out;
}

export function jsonRecordValue(
  value: unknown,
): Readonly<Record<string, JsonValue>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) return undefined;
    if (!isJsonValue(item)) return undefined;
    out[key] = item;
  }
  return out;
}

export function outputAllowlistValue(
  value: unknown,
): Readonly<Record<string, OutputAllowlistEntry>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, OutputAllowlistEntry> = {};
  for (const [name, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) return undefined;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    const from = stringValue(record.from);
    const type = stringValue(record.type);
    if (!from || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(from)) return undefined;
    if (
      type !== "string" &&
      type !== "url" &&
      type !== "hostname" &&
      type !== "number" &&
      type !== "boolean" &&
      type !== "json"
    ) {
      return undefined;
    }
    const required = booleanValue(record.required);
    out[name] = {
      from,
      type,
      ...(required !== undefined ? { required } : {}),
    };
  }
  return out;
}

export function installConfigStoreValue(
  value: unknown,
): InstallConfigStoreMetadata | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const order = numberValue(record.order);
  const surface = storeSurfaceValue(record.surface);
  const kind = storeKindValue(record.kind);
  const provider = boundedStringValue(record.provider, 64);
  const suggestedName = boundedStringValue(record.suggestedName, 96);
  const badge = storeTextValue(record.badge);
  const name = storeTextValue(record.name);
  const description = storeTextValue(record.description);
  const inputs = storeInputsValue(record.inputs);
  const iconUrl =
    record.iconUrl === undefined
      ? undefined
      : boundedStringValue(record.iconUrl, 2048);
  const installExperience =
    record.installExperience === undefined
      ? undefined
      : installExperienceValue(record.installExperience);
  if (
    order === undefined ||
    !surface ||
    !kind ||
    !provider ||
    !suggestedName ||
    !badge ||
    !name ||
    !description ||
    !inputs ||
    (record.iconUrl !== undefined && iconUrl === undefined) ||
    (record.installExperience !== undefined && installExperience === undefined)
  ) {
    return undefined;
  }
  const templateId = boundedTokenValue(record.templateId, 128);
  const templateVersion = boundedTokenValue(record.templateVersion, 128);
  const source = storeSourceValue(record.source);
  if (record.source !== undefined && !source) return undefined;
  return {
    ...(templateId ? { templateId } : {}),
    ...(templateVersion ? { templateVersion } : {}),
    ...(source ? { source } : {}),
    order,
    surface,
    kind,
    provider,
    suggestedName,
    badge,
    name,
    description,
    ...(iconUrl ? { iconUrl } : {}),
    inputs,
    ...(installExperience ? { installExperience } : {}),
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function boundedStringValue(
  value: unknown,
  maxLength: number,
): string | undefined {
  const raw = stringValue(value)?.trim();
  if (!raw || raw.length > maxLength) return undefined;
  return raw;
}

function boundedTokenValue(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  const raw = boundedStringValue(value, maxLength);
  if (!raw || !/^[A-Za-z0-9_.:-]+$/u.test(raw)) return undefined;
  return raw;
}

function storeTextValue(value: unknown): InstallConfigStoreText | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const ja = boundedStringValue(record.ja, 500);
  const en = boundedStringValue(record.en, 500);
  return ja && en ? { ja, en } : undefined;
}

function storeSourceValue(
  value: unknown,
): InstallConfigStoreMetadata["source"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const git = boundedStringValue(record.git, 2048);
  const parsedPath = modulePathValue(record.path);
  if (record.path !== undefined && parsedPath === undefined) return undefined;
  const path = parsedPath === "" ? "." : (parsedPath ?? ".");
  if (!git || !/^https?:\/\/|^git@/u.test(git)) return undefined;
  return { git, path };
}

function storeSurfaceValue(
  value: unknown,
): InstallConfigStoreSurface | undefined {
  return value === "service" ||
    value === "building_block" ||
    value === "example"
    ? value
    : undefined;
}

function storeKindValue(value: unknown): InstallConfigStoreKind | undefined {
  return value === "worker" || value === "storage" || value === "site"
    ? value
    : undefined;
}

function storeInputsValue(
  value: unknown,
): readonly InstallConfigStoreInput[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) return undefined;
  const inputs: InstallConfigStoreInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    const name = boundedTokenValue(record.name, 64);
    const type =
      record.type === undefined
        ? undefined
        : record.type === "string" ||
            record.type === "number" ||
            record.type === "boolean" ||
            record.type === "json"
          ? record.type
          : undefined;
    const format =
      record.format === undefined
        ? undefined
        : storeInputFormatValue(record.format);
    const required = booleanValue(record.required);
    const defaultValue =
      record.defaultValue === undefined
        ? undefined
        : boundedStringValue(record.defaultValue, 16_384);
    const label = storeTextValue(record.label);
    const helper =
      record.helper === undefined ? undefined : storeTextValue(record.helper);
    const placeholder =
      record.placeholder === undefined
        ? undefined
        : boundedStringValue(record.placeholder, 256);
    if (
      !name ||
      (record.type !== undefined && !type) ||
      (record.format !== undefined && !format) ||
      (record.defaultValue !== undefined && defaultValue === undefined) ||
      !label ||
      (record.helper !== undefined && !helper) ||
      (record.placeholder !== undefined && placeholder === undefined)
    ) {
      return undefined;
    }
    inputs.push({
      name,
      ...(type ? { type } : {}),
      ...(format ? { format } : {}),
      ...(required !== undefined ? { required } : {}),
      ...(record.advanced === true ? { advanced: true } : {}),
      ...(record.secret === true ? { secret: true } : {}),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      label,
      ...(helper ? { helper } : {}),
      ...(placeholder ? { placeholder } : {}),
    });
  }
  return inputs;
}

function storeInputFormatValue(
  value: unknown,
): InstallConfigStoreInput["format"] | undefined {
  return value === "text" ||
    value === "url" ||
    value === "hostname" ||
    value === "subdomain" ||
    value === "password" ||
    value === "token" ||
    value === "email" ||
    value === "sha256"
    ? value
    : undefined;
}

function storeVariableNameValue(value: unknown): string | undefined {
  const raw = boundedStringValue(value, 128);
  return raw && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(raw) ? raw : undefined;
}

function storePathValue(value: unknown): string | undefined {
  const raw = boundedStringValue(value, 256);
  return raw && raw.startsWith("/") ? raw : undefined;
}

function optionalStoreVariable(value: unknown): string | undefined | false {
  if (value === undefined) return undefined;
  return storeVariableNameValue(value) ?? false;
}

function installExperienceValue(
  value: unknown,
): InstallConfigInstallExperience | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const out: {
    projections?: InstallConfigInstallProjection[];
  } = {};

  if (record.projections === undefined) {
    return Object.keys(record).length === 0 ? out : undefined;
  }
  if (Object.keys(record).some((key) => key !== "projections")) {
    return undefined;
  }
  const projections = installExperienceProjectionsValue(record.projections);
  if (!projections) return undefined;
  out.projections = [...projections];

  return out;
}

function installExperienceProjectionsValue(
  value: unknown,
): readonly InstallConfigInstallProjection[] | undefined {
  if (!Array.isArray(value) || value.length > 20) return undefined;
  const projections: InstallConfigInstallProjection[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    if (record.kind === "service_name") {
      const variable = storeVariableNameValue(record.variable);
      if (!variable) return undefined;
      projections.push({ kind: "service_name", variable });
      continue;
    }
    if (record.kind === "public_endpoint") {
      if (
        !record.variables ||
        typeof record.variables !== "object" ||
        Array.isArray(record.variables)
      ) {
        return undefined;
      }
      const variables = record.variables as Record<string, unknown>;
      const subdomain = optionalStoreVariable(variables.subdomain);
      const url = optionalStoreVariable(variables.url);
      const routePattern = optionalStoreVariable(variables.routePattern);
      const baseDomain =
        record.baseDomain === undefined
          ? undefined
          : boundedStringValue(record.baseDomain, 255);
      if (
        subdomain === false ||
        url === false ||
        routePattern === false ||
        (record.baseDomain !== undefined && baseDomain === undefined)
      ) {
        return undefined;
      }
      projections.push({
        kind: "public_endpoint",
        variables: {
          ...(subdomain ? { subdomain } : {}),
          ...(url ? { url } : {}),
          ...(routePattern ? { routePattern } : {}),
        },
        ...(baseDomain ? { baseDomain } : {}),
      });
      continue;
    }
    if (record.kind === "initial_secret") {
      const variable = storeVariableNameValue(record.variable);
      const secretKind =
        record.secretKind === undefined
          ? undefined
          : record.secretKind === "password" ||
              record.secretKind === "password_or_hash" ||
              record.secretKind === "token"
            ? record.secretKind
            : undefined;
      const optional = booleanValue(record.optional);
      if (
        !variable ||
        (record.secretKind !== undefined && secretKind === undefined) ||
        (record.optional !== undefined && optional === undefined)
      ) {
        return undefined;
      }
      projections.push({
        kind: "initial_secret",
        variable,
        ...(secretKind ? { secretKind } : {}),
        ...(optional !== undefined ? { optional } : {}),
      });
      continue;
    }
    if (record.kind === "oidc_client") {
      if (
        !record.variables ||
        typeof record.variables !== "object" ||
        Array.isArray(record.variables)
      ) {
        return undefined;
      }
      const variables = record.variables as Record<string, unknown>;
      const issuerUrl = optionalStoreVariable(variables.issuerUrl);
      const accountsUrl = optionalStoreVariable(variables.accountsUrl);
      const clientId = optionalStoreVariable(variables.clientId);
      const redirectUri = optionalStoreVariable(variables.redirectUri);
      const callbackPath =
        record.callbackPath === undefined
          ? undefined
          : storePathValue(record.callbackPath);
      const scopes = oidcProjectionScopes(record.scopes);
      if (
        issuerUrl === false ||
        accountsUrl === false ||
        clientId === false ||
        redirectUri === false ||
        (record.callbackPath !== undefined && callbackPath === undefined) ||
        (record.scopes !== undefined && scopes === undefined)
      ) {
        return undefined;
      }
      projections.push({
        kind: "oidc_client",
        variables: {
          ...(issuerUrl ? { issuerUrl } : {}),
          ...(accountsUrl ? { accountsUrl } : {}),
          ...(clientId ? { clientId } : {}),
          ...(redirectUri ? { redirectUri } : {}),
        },
        ...(callbackPath ? { callbackPath } : {}),
        ...(scopes ? { scopes } : {}),
      });
      continue;
    }
    if (record.kind === "artifact") {
      if (
        !record.variables ||
        typeof record.variables !== "object" ||
        Array.isArray(record.variables)
      ) {
        return undefined;
      }
      const variables = record.variables as Record<string, unknown>;
      const url = optionalStoreVariable(variables.url);
      const sha256 = optionalStoreVariable(variables.sha256);
      if (url === false || sha256 === false) return undefined;
      projections.push({
        kind: "artifact",
        variables: {
          ...(url ? { url } : {}),
          ...(sha256 ? { sha256 } : {}),
        },
      });
      continue;
    }
    return undefined;
  }
  return projections;
}

function oidcProjectionScopes(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const scopes = value.map((scope) =>
    typeof scope === "string" ? scope.trim() : "",
  );
  if (
    scopes.some((scope) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(scope))
  ) {
    return undefined;
  }
  return [...new Set(scopes)];
}

export function modulePathValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const raw = stringValue(value)?.trim();
  if (!raw) return undefined;
  if (isAbsolute(raw) || raw.includes("\0") || /^[A-Za-z]:[\\/]/u.test(raw)) {
    return undefined;
  }
  const normalized = normalize(raw)
    .replace(/\\/g, "/")
    .replace(/^\.\/+/u, "")
    .replace(/\/+$/u, "");
  if (!normalized || normalized === ".") return "";
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return undefined;
  }
  return normalized;
}

export function sourceBuildValue(
  value: unknown,
): SourceBuildConfig | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  if (
    !Array.isArray(value.commands) ||
    value.commands.length === 0 ||
    value.commands.length > 8 ||
    !Array.isArray(value.outputs) ||
    value.outputs.length === 0 ||
    value.outputs.length > 16
  ) {
    return undefined;
  }
  const commands: SourceBuildConfig["commands"][number][] = [];
  for (const commandValue of value.commands) {
    if (!isPlainJsonObject(commandValue) || !Array.isArray(commandValue.argv)) {
      return undefined;
    }
    const argv = commandValue.argv;
    if (
      argv.length === 0 ||
      argv.length > 32 ||
      argv.some(
        (argument) =>
          typeof argument !== "string" ||
          argument.length === 0 ||
          argument.length > 4096 ||
          argument.includes("\0"),
      )
    ) {
      return undefined;
    }
    const workingDirectory =
      commandValue.workingDirectory === undefined
        ? undefined
        : modulePathValue(commandValue.workingDirectory);
    if (
      commandValue.workingDirectory !== undefined &&
      workingDirectory === undefined
    ) {
      return undefined;
    }
    commands.push({
      argv: [...argv] as string[],
      ...(workingDirectory ? { workingDirectory } : {}),
    });
  }
  const outputs: string[] = [];
  for (const output of value.outputs) {
    const normalized = modulePathValue(output);
    if (!normalized) return undefined;
    outputs.push(normalized);
  }
  return { commands, outputs };
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
}

export function parseCapsuleProviderConnectionBindings(value: unknown):
  | {
      readonly ok: true;
      readonly bindings: CapsuleProviderConnectionBindings;
    }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  if (!Array.isArray(value)) {
    return { ok: false, message: "connections must be an array" };
  }
  const connections: CapsuleProviderConnectionBinding[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = parseCapsuleProviderConnectionBinding(item);
    if (!parsed.ok) {
      return {
        ok: false,
        message: `connections[${index}]: ${parsed.message}`,
      };
    }
    connections.push(parsed.binding);
  }
  return { ok: true, bindings: connections };
}

export function parseCapsuleProviderConnectionBinding(value: unknown):
  | {
      readonly ok: true;
      readonly binding: CapsuleProviderConnectionBinding;
    }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, message: "connection must be an object" };
  }
  const input = value as Record<string, unknown>;
  const provider = stringValue(input.provider);
  if (!provider) return { ok: false, message: "provider is required" };
  const connectionId = stringValue(input.connectionId);
  if (!connectionId) {
    return { ok: false, message: "connectionId is required" };
  }
  const binding: {
    provider: string;
    alias?: string;
    connectionId: string;
    region?: string;
  } = { provider, connectionId };
  const alias = stringValue(input.alias);
  if (alias) binding.alias = alias;
  const region = stringValue(input.region);
  if (region) binding.region = region;
  return { ok: true, binding };
}

export function isPlainJsonObject(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerces a JSON object of write-only credential `values` into a string map.
 * Non-string entries are dropped. NOTE: never log the returned map — it holds
 * secret credential material.
 */
export function stringRecord(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

export function connectionCredentialFiles(
  value: unknown,
):
  | { readonly ok: true; readonly files: readonly CreateConnectionFile[] }
  | { readonly ok: false; readonly message: string } {
  if (value === undefined) return { ok: true, files: [] };
  if (!Array.isArray(value)) {
    return { ok: false, message: "files must be an array" };
  }
  const files: CreateConnectionFile[] = [];
  for (const [index, item] of value.entries()) {
    if (!isPlainJsonObject(item)) {
      return { ok: false, message: `files[${index}] must be an object` };
    }
    const path = stringValue(item.path);
    const content = stringValue(item.content);
    if (!path) {
      return { ok: false, message: `files[${index}].path is required` };
    }
    if (content === undefined) {
      return { ok: false, message: `files[${index}].content is required` };
    }
    const mode =
      typeof item.mode === "number" && Number.isInteger(item.mode)
        ? item.mode
        : undefined;
    if (item.mode !== undefined && mode === undefined) {
      return { ok: false, message: `files[${index}].mode must be an integer` };
    }
    const envName = stringValue(item.envName);
    files.push({
      path,
      content,
      ...(mode !== undefined ? { mode } : {}),
      ...(envName ? { envName } : {}),
    });
  }
  return { ok: true, files };
}

/**
 * Extracts the non-secret connection scope hints the UI may pass. Only the
 * well-known string fields are forwarded.
 */
export function connectionScopeHints(
  value: unknown,
): ConnectionScopeHints | undefined {
  if (!isPlainJsonObject(value)) return undefined;
  const hints: Record<string, string> = {};
  for (const key of [
    "accountId",
    "zoneId",
    "workersSubdomain",
    "repoUrl",
    "username",
    "knownHostsEntry",
    "awsRegion",
    "gcpProjectId",
    "gcpServiceAccountEmail",
    "templateId",
  ] as const) {
    const v = stringValue(value[key]);
    if (v) hints[key] = v;
  }
  return Object.keys(hints).length > 0
    ? (hints as ConnectionScopeHints)
    : undefined;
}

export function connectionScopeHintsFromValues(
  provider: string,
  values: Readonly<Record<string, string>>,
  explicit: unknown,
): ConnectionScopeHints | undefined {
  const derived: Record<string, string> = {};
  if (provider === "cloudflare") {
    const accountId = stringValue(values.CLOUDFLARE_ACCOUNT_ID);
    if (accountId) derived.accountId = accountId;
  }
  if (isGoogleCloudProvider(provider)) {
    const projectId =
      stringValue(values.GOOGLE_CLOUD_PROJECT) ??
      stringValue(values.GOOGLE_PROJECT);
    if (projectId) derived.gcpProjectId = projectId;
  }
  const hints = {
    ...derived,
    ...(connectionScopeHints(explicit) ?? {}),
  };
  return Object.keys(hints).length > 0
    ? (hints as ConnectionScopeHints)
    : undefined;
}

export function isGoogleCloudProvider(provider: string): boolean {
  const normalized = provider.trim().toLowerCase();
  return normalized === "gcp" || normalized === "google";
}

export function spaceTypeValue(value: unknown): WorkspaceType | undefined {
  return value === "personal" || value === "organization" ? value : undefined;
}

export function dependencyModeValue(
  value: unknown,
): DependencyMode | undefined {
  return value === "variable_injection" ||
    value === "remote_state" ||
    value === "published_output"
    ? value
    : undefined;
}

export function dependencyVisibilityValue(
  value: unknown,
): DependencyVisibility | undefined {
  return value === "space" || value === "cross_space" ? value : undefined;
}

export function isOutputsMapping(
  value: unknown,
): value is Readonly<Record<string, DependencyOutputMapping>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function outputShareEntries(value: unknown):
  | readonly {
      readonly name: string;
      readonly alias?: string;
      readonly sensitive?: boolean;
    }[]
  | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: {
    name: string;
    alias?: string;
    sensitive?: boolean;
  }[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return undefined;
    const record = item as Record<string, unknown>;
    const name = stringValue(record.name);
    if (!name) return undefined;
    out.push({
      name,
      ...(stringValue(record.alias)
        ? { alias: stringValue(record.alias) }
        : {}),
      ...(record.sensitive === true ? { sensitive: true } : {}),
    });
  }
  return out;
}

export function outputShareSensitivePolicy(
  value: unknown,
): { readonly allow: boolean; readonly reason?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.allow !== true) return undefined;
  const reason = stringValue(record.reason);
  return {
    allow: true,
    ...(reason ? { reason } : {}),
  };
}

export function parseLimit(
  value: string | null,
): number | undefined | "invalid" {
  if (value === null || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return "invalid";
  return parsed;
}
