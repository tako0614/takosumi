/**
 * Request / source validation and identity checks for the deploy-control domain.
 *
 * These pure guards validate PlanRun/ApplyRun request shape, OpenTofu module
 * source identity, operation/installation invariants, and derive normalized
 * variables/providers and an appId from a source. They throw
 * `OpenTofuControllerError` on invalid input; no controller or store state.
 */

import type { JsonValue } from "takosumi-contract";
import type {
  Installation,
  OpenTofuModuleSource,
  OpenTofuOperation,
  PlanRun,
  RunnerProfile,
} from "takosumi-contract/deploy-control-api";
import {
  isRecord,
  OpenTofuControllerError,
  requireNonEmptyString,
} from "./errors.ts";
import {
  assertHostNotBlocked,
  BlockedHostError,
} from "../../../deploy-control/host-blocklist.ts";

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function validateOperationInstallationShape(input: {
  readonly operation: OpenTofuOperation;
  readonly installation?: Installation;
  readonly requestedSpaceId: string;
  readonly requestedSource: OpenTofuModuleSource;
  readonly runnerProfileId: string;
}): void {
  if (input.operation === "create" && input.installation) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "create PlanRun must not target an existing installationId",
    );
  }
  if (
    (input.operation === "update" || input.operation === "destroy") &&
    !input.installation
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `${input.operation} PlanRun requires installationId`,
    );
  }
  if (
    input.installation &&
    input.installation.spaceId !== input.requestedSpaceId
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `installation ${input.installation.id} belongs to space ${input.installation.spaceId}, not ${input.requestedSpaceId}`,
    );
  }
  if (!input.installation) return;
  if (
    (input.operation === "update" || input.operation === "destroy") &&
    input.installation.currentDeploymentId === null
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `${input.operation} PlanRun requires an Installation with a current Deployment`,
    );
  }
  if (input.installation.runnerProfileId !== input.runnerProfileId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `installation ${input.installation.id} uses runner profile ${input.installation.runnerProfileId}, not ${input.runnerProfileId}`,
    );
  }
  if (!sourceIdentityMatches(input.installation.source, input.requestedSource)) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `installation ${input.installation.id} source identity does not match the requested OpenTofu module source`,
    );
  }
}

export function validatePlannedInstallationCurrent(input: {
  readonly planRun: PlanRun;
  readonly installation: Installation;
}): void {
  if (input.installation.spaceId !== input.planRun.spaceId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `installation ${input.installation.id} no longer belongs to PlanRun space ${input.planRun.spaceId}`,
    );
  }
  if (input.installation.runnerProfileId !== input.planRun.runnerProfileId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `installation ${input.installation.id} runner profile changed since PlanRun ${input.planRun.id}`,
    );
  }
  if (
    !sourceIdentityMatches(input.installation.source, input.planRun.source)
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `installation ${input.installation.id} source identity changed since PlanRun ${input.planRun.id}`,
    );
  }
  const expectedCurrentDeploymentId =
    input.planRun.installationCurrentDeploymentId ?? null;
  if (input.installation.currentDeploymentId !== expectedCurrentDeploymentId) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `installation ${input.installation.id} current Deployment changed since PlanRun ${input.planRun.id}`,
    );
  }
}

function sourceIdentityMatches(
  existing: OpenTofuModuleSource,
  requested: OpenTofuModuleSource,
): boolean {
  if (existing.kind !== requested.kind) return false;
  if ((existing.modulePath ?? "") !== (requested.modulePath ?? "")) return false;
  if (existing.kind === "git" && requested.kind === "git") {
    return existing.url === requested.url;
  }
  if (existing.kind === "prepared" && requested.kind === "prepared") {
    return existing.url === requested.url;
  }
  if (existing.kind === "local" && requested.kind === "local") {
    return existing.path === requested.path;
  }
  return false;
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
  variables: Readonly<Record<string, JsonValue>> | undefined,
): Readonly<Record<string, JsonValue>> {
  if (variables === undefined) return {};
  if (!isRecord(variables) || Array.isArray(variables)) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "variables must be a JSON object",
    );
  }
  return variables;
}

export function validateOperation(operation: OpenTofuOperation): void {
  if (operation === "create" || operation === "update" || operation === "destroy") {
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
      if (source.ref !== undefined) requireNonEmptyString(source.ref, "source.ref");
      if (source.commit !== undefined) {
        requireNonEmptyString(source.commit, "source.commit");
        if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(source.commit)) {
          throw new OpenTofuControllerError(
            "invalid_argument",
            "source.commit must be a full git object id",
          );
        }
      }
      if (source.ref !== undefined) validateSafeGitSelector(source.ref, "source.ref");
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

export function appIdFromSource(source: OpenTofuModuleSource): string {
  const seed = source.kind === "local" ? source.path : source.url;
  const withoutQuery = seed.split(/[?#]/)[0] ?? seed;
  const parts = withoutQuery.split(/[/:]/).filter((part) => part.length > 0);
  const name = (parts[parts.length - 1] ?? source.kind).replace(/\.git$/, "");
  const moduleSuffix = source.modulePath
    ? `-${source.modulePath.replace(/[^a-zA-Z0-9._-]+/g, "-")}`
    : "";
  return `${name}${moduleSuffix}`.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "opentofu-module";
}
