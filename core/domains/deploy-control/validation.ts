/**
 * Request / source validation and identity checks for the deploy-control domain.
 *
 * These pure guards validate PlanRun/ApplyRun request shape, OpenTofu module
 * source identity, the planned-installation generation guard, and derive
 * normalized variables/providers. They throw `OpenTofuControllerError` on
 * invalid input; no controller or store state.
 */

import type { JsonValue } from "takosumi-contract";
import type {
  Installation,
  OpenTofuModuleSource,
  OpenTofuOperation,
  PlanRun,
  RunnerProfile,
} from "@takosumi/internal/deploy-control-api";
import {
  isRecord,
  OpenTofuControllerError,
  requireNonEmptyString,
} from "./errors.ts";
import {
  assertHostNotBlocked,
  BlockedHostError,
} from "takosumi-contract/reference/host-blocklist";

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * Apply-time guard that the planned Installation still matches the PlanRun: it
 * has not moved to another Space and its current Deployment has not advanced
 * since the plan was created.
 *
 * The Space-direct Installation no longer carries `runnerProfileId` or a
 * `source` identity (those are resolved through the InstallConfig / Source),
 * so only the Space binding and the current-Deployment cursor are checked here.
 * `Installation.currentDeploymentId` is optional (`string | undefined`) while
 * `PlanRun.installationCurrentDeploymentId` stays `string | null` internally;
 * both null and undefined mean "no current Deployment", so they are normalized
 * before comparison.
 */
export function validatePlannedInstallationCurrent(input: {
  readonly planRun: PlanRun;
  readonly installation: Installation;
}): void {
  if (input.installation.spaceId !== input.planRun.spaceId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "capsule no longer belongs to the planned workspace",
    );
  }
  const actualCurrentDeploymentId =
    input.installation.currentDeploymentId ?? null;
  const expectedCurrentDeploymentId =
    input.planRun.installationCurrentDeploymentId ?? null;
  if (actualCurrentDeploymentId !== expectedCurrentDeploymentId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `installation ${input.installation.id} current Deployment changed since PlanRun ${input.planRun.id}`,
    );
  }
}

export function validateSourceAllowedByProfile(
  source: OpenTofuModuleSource,
  profile: RunnerProfile,
): void {
  if (source.kind !== "local") return;
  if (profile.sourcePolicy?.allowLocalSource === true) return;
  throw new OpenTofuControllerError(
    "failed_precondition",
    `runner profile ${profile.id} does not allow local source paths`,
  );
}

export function normalizeProviders(
  providers: readonly string[],
): readonly string[] {
  return providers.map((provider) => {
    requireNonEmptyString(provider, "requiredProviders[]");
    return provider;
  });
}

export function normalizeVariables(
  variables: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, JsonValue>> {
  if (variables === undefined) return {};
  if (!isRecord(variables) || Array.isArray(variables)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "variables must be a JSON object",
    );
  }
  return normalizeVariablePathRecord(variables, "variables");
}

const VARIABLE_PATH_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function normalizeVariablePathRecord(
  variables: Readonly<Record<string, unknown>>,
  fieldName = "variables",
): Readonly<Record<string, JsonValue>> {
  const out: Record<string, JsonValue> = {};
  for (const [rawKey, value] of Object.entries(variables)) {
    if (!isJsonValue(value)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `${fieldName}.${rawKey} must be a JSON value`,
      );
    }
    const path = normalizedVariablePath(rawKey, fieldName);
    writeVariablePath(out, path, value, fieldName);
  }
  return out;
}

function normalizedVariablePath(
  rawKey: string,
  fieldName: string,
): readonly string[] {
  const path = rawKey.split(".");
  if (
    path.length === 0 ||
    path.some((segment) => !isSafeVariablePathSegment(segment))
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${fieldName}.${rawKey} must use dot-separated OpenTofu variable identifier segments`,
    );
  }
  return path;
}

function isSafeVariablePathSegment(segment: string): boolean {
  return (
    VARIABLE_PATH_SEGMENT_RE.test(segment) && !RESERVED_OBJECT_KEYS.has(segment)
  );
}

function writeVariablePath(
  target: Record<string, JsonValue>,
  path: readonly string[],
  value: JsonValue,
  fieldName: string,
): void {
  let cursor = target;
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]!;
    const fieldPath = `${fieldName}.${path.slice(0, index + 1).join(".")}`;
    if (index === path.length - 1) {
      cursor[segment] = mergeVariableValue(cursor[segment], value, fieldPath);
      return;
    }
    const existing = cursor[segment];
    if (existing === undefined) {
      const next: Record<string, JsonValue> = {};
      cursor[segment] = next;
      cursor = next;
      continue;
    }
    if (!isJsonObject(existing)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `${fieldPath} conflicts with another variable path`,
      );
    }
    cursor = existing as Record<string, JsonValue>;
  }
}

function mergeVariableValue(
  existing: JsonValue | undefined,
  incoming: JsonValue,
  fieldPath: string,
): JsonValue {
  if (existing === undefined) return cloneJsonValue(incoming);
  if (isJsonObject(existing) && isJsonObject(incoming)) {
    const merged: Record<string, JsonValue> = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = mergeVariableValue(
        merged[key],
        value,
        `${fieldPath}.${key}`,
      );
    }
    return merged;
  }
  if (JSON.stringify(existing) === JSON.stringify(incoming)) {
    return cloneJsonValue(existing);
  }
  throw new OpenTofuControllerError(
    "invalid_argument",
    `${fieldPath} conflicts with another variable path`,
  );
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (isJsonObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = cloneJsonValue(item);
    }
    return out;
  }
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (type !== "object") return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, nested]) => !RESERVED_OBJECT_KEYS.has(key) && isJsonValue(nested),
  );
}

function isJsonObject(
  value: JsonValue | undefined,
): value is Readonly<Record<string, JsonValue>> {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

export function validateOperation(operation: OpenTofuOperation): void {
  if (
    operation === "create" ||
    operation === "update" ||
    operation === "destroy"
  ) {
    return;
  }
  throw new OpenTofuControllerError(
    "invalid_argument",
    "operation must be create, update, or destroy",
  );
}

export function validateSource(source: OpenTofuModuleSource): void {
  if (!isRecord(source)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "source must be a JSON object",
    );
  }
  switch (source.kind) {
    case "git":
      requireNonEmptyString(source.url, "source.url");
      validateHttpsSourceUrl(source.url, "git source url");
      if (source.ref !== undefined)
        requireNonEmptyString(source.ref, "source.ref");
      if (source.commit !== undefined) {
        requireNonEmptyString(source.commit, "source.commit");
        if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(source.commit)) {
          throw new OpenTofuControllerError(
            "invalid_argument",
            "source.commit must be a full git object id",
          );
        }
      }
      if (source.ref !== undefined)
        validateSafeGitSelector(source.ref, "source.ref");
      break;
    case "prepared":
      requireNonEmptyString(source.url, "source.url");
      validateHttpsSourceUrl(source.url, "prepared source url");
      requireNonEmptyString(source.digest, "source.digest");
      if (!SHA256_DIGEST_RE.test(source.digest)) {
        throw new OpenTofuControllerError(
          "invalid_argument",
          "prepared source digest must be sha256:<64 lowercase hex>",
        );
      }
      break;
    case "local":
      requireNonEmptyString(source.path, "source.path");
      break;
    default:
      throw new OpenTofuControllerError(
        "invalid_argument",
        "source.kind must be git, prepared, or local",
      );
  }
  if (source.modulePath !== undefined) {
    requireNonEmptyString(source.modulePath, "source.modulePath");
    validateSafeModulePath(source.modulePath);
  }
}

function validateHttpsSourceUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${label} must be a valid URL`,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${label} must use https://`,
    );
  }
  if (!parsed.hostname) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${label} must include a host`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${label} must not embed credentials`,
    );
  }
  try {
    assertHostNotBlocked(parsed.hostname, `${label} host`);
  } catch (error) {
    if (error instanceof BlockedHostError) {
      throw new OpenTofuControllerError("invalid_argument", error.message);
    }
    throw error;
  }
}

function validateSafeGitSelector(value: string, label: string): void {
  if (value.startsWith("-") || /[\r\n\0]/.test(value)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${label} must not start with '-' or contain control characters`,
    );
  }
}

function validateSafeModulePath(modulePath: string): void {
  if (
    modulePath.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(modulePath) ||
    modulePath.split(/[\\/]+/).some((part) => part === "..")
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "source.modulePath must stay inside the source root",
    );
  }
}
