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
import type { Space, SpaceType } from "takosumi-contract/spaces";
import type {
  InstallationProviderEnvBindingSet,
  InstallConfig,
  Installation,
  OutputAllowlistEntry,
  PolicyConfig,
  PublicInstallConfig,
  PublicInstallation,
} from "takosumi-contract/installations";
import type {
  Dependency,
  DependencyMode,
  DependencyOutputMapping,
  DependencyVisibility,
} from "takosumi-contract/dependencies";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { Page, PageParams } from "takosumi-contract/pagination";
import type {
  InstallationProviderConnectionBinding,
  InstallationProviderConnectionBindings,
  InstallationProviderEnvBinding,
  InstallationProviderEnvBindings,
  InstallationProviderConnectionSet,
  ProviderConnection,
} from "takosumi-contract/connections";
import type {
  ProviderResolution,
  PublicProviderResolution,
} from "takosumi-contract/provider-resolution";
import type {
  OutputShare,
  OutputShareEntry,
} from "takosumi-contract/output-snapshots";
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

export function modulePathValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const raw = stringValue(value)?.trim();
  if (!raw) return undefined;
  if (isAbsolute(raw) || raw.includes("\0") || /^[A-Za-z]:[\\/]/u.test(raw)) {
    return undefined;
  }
  const normalized = normalize(raw)
    .replace(/\\/g, "/")
    .replace(/^\.\/+/u, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
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

export function parseInstallationProviderConnectionBindings(value: unknown):
  | {
      readonly ok: true;
      readonly bindings: InstallationProviderConnectionBindings;
    }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  if (!Array.isArray(value)) {
    return { ok: false, message: "connections must be an array" };
  }
  const connections: InstallationProviderConnectionBinding[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = parseInstallationProviderConnectionBinding(item);
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

export function parseInstallationProviderConnectionBinding(value: unknown):
  | {
      readonly ok: true;
      readonly binding: InstallationProviderConnectionBinding;
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

export function spaceTypeValue(value: unknown): SpaceType | undefined {
  return value === "personal" || value === "organization" ? value : undefined;
}

export function dependencyModeValue(value: unknown): DependencyMode | undefined {
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

export function parseLimit(value: string | null): number | undefined | "invalid" {
  if (value === null || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return "invalid";
  return parsed;
}
