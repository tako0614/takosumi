/**
 * Default OpenTofu runner profile seed data.
 *
 * Provider identity is deliberately not part of runner selection. Every valid
 * OpenTofu provider uses the same isolated execution surface; provider-specific
 * credential convenience belongs to Credential Recipes and Provider
 * Connections, while explicit operator deny policy remains the admission
 * boundary.
 */

import type { RunnerProfile } from "@takosumi/internal/deploy-control-api";
import { CAPSULE_LIFECYCLE_COMMAND_CAPABILITY } from "takosumi-contract/install-configs";

/** The provider-neutral runner selected for ordinary OpenTofu Capsules. */
export const DEFAULT_OPENTOFU_RUNNER_PROFILE_ID = "opentofu-default";
/** Explicit registry key used by the reference OpenTofu executor adapter. */
export const DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID = "opentofu.default";

const PROFILE_LIFECYCLE_STATES = new Set([
  "candidate",
  "active",
  "reserved",
]);
const PROFILE_AVAILABILITY_STATES = new Set(["available", "unavailable"]);
const RUNNER_PROFILE_KEYS = new Set([
  "id",
  "name",
  "substrate",
  "executorId",
  "lifecycle",
  "availability",
  "description",
  "tofuVersion",
  "stateBackend",
  "capabilities",
  "allowedProviders",
  "deniedProviders",
  "requireProviderBindings",
  "resourceLimits",
  "networkPolicy",
  "secretExposurePolicy",
  "concurrency",
  "labels",
  "executionEvidenceAuthority",
  "createdAt",
]);
const SECRET_PROVIDER_CREDENTIAL_EXPOSURES = new Set([
  "runner-only",
  "operator-managed",
  "forbidden",
]);
const SECRET_TENANT_OPERATOR_EXPOSURES = new Set([
  "forbidden",
  "tenant-scoped-references-only",
  "operator-managed",
]);
const PROFILE_LIFECYCLE_KEYS = new Set(["state", "reason"]);
const PROFILE_AVAILABILITY_KEYS = new Set(["state", "reason"]);
const PROFILE_STATE_BACKEND_KEYS = new Set(["kind", "ref", "lock"]);
const PROFILE_STATE_LOCK_KEYS = new Set(["kind", "ref"]);
const PROFILE_RESOURCE_LIMIT_KEYS = new Set([
  "maxRunSeconds",
  "maxSourceArchiveBytes",
  "maxSourceDecompressedBytes",
  "cpu",
  "memoryMb",
]);
const PROFILE_NETWORK_POLICY_KEYS = new Set([
  "mode",
  "allowedHosts",
  "allowedHostPatterns",
]);
const PROFILE_SECRET_EXPOSURE_KEYS = new Set([
  "providerCredentials",
  "tenantWorkerOperatorSecrets",
  "redactLogs",
  "blockSensitiveOutputs",
]);

/**
 * Validate a complete host-provided RunnerProfile catalog before it can reach
 * the controller's asynchronous seed. Runtime composition is deliberately
 * checked here rather than relying on the TypeScript interface: production
 * hosts can provide values from another bundle or realm, and a partial value
 * must never be written to the runner-profile ledger and only fail later when
 * a Run happens to select it.
 */
export function assertRunnerProfileCatalog(
  value: unknown,
  options: Readonly<{
    /** Host-code compositions use the current closed profile contract. */
    readonly rejectUnknownKeys?: boolean;
    /** Host-code compositions must include ledger metadata for each profile. */
    readonly requireCreatedAt?: boolean;
  }> = {},
): asserts value is readonly RunnerProfile[] {
  if (!Array.isArray(value)) {
    throw new TypeError("runner profiles must be an array");
  }
  const ids = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const profile = assertRunnerProfileShape(candidate, index, options);
    if (ids.has(profile.id)) {
      throw new Error(`duplicate runner profile id ${profile.id}`);
    }
    ids.add(profile.id);
  }
}

/**
 * Resolve the operator-configured execution profiles. The default is the one
 * provider-neutral OpenTofu profile. Additional profiles are operator-defined
 * execution capabilities (for example a private-network or host-agent runner),
 * never built-in provider brands.
 */
export function resolveEnabledRunnerProfiles(
  allProfiles: readonly RunnerProfile[],
  envValue: string | undefined,
): readonly RunnerProfile[] {
  assertRunnerProfileCatalog(allProfiles);
  const byId = new Map(allProfiles.map((profile) => [profile.id, profile]));
  const requestedIds = parseEnabledRunnerProfileIds(envValue);
  const enabled: RunnerProfile[] = [];
  const unknownIds: string[] = [];
  for (const id of requestedIds) {
    const profile = byId.get(id);
    if (!profile) {
      unknownIds.push(id);
      continue;
    }
    enabled.push(activateRequestedProfile(profile));
  }
  if (unknownIds.length > 0) {
    throw new Error(
      `unknown runner profile id ${unknownIds.join(", ")}; known ids: ${
        Array.from(byId.keys()).join(", ")
      }`,
    );
  }
  return enabled;
}

/** Parse a strict CSV profile list; an empty value selects the default. */
export function parseEnabledRunnerProfileIds(
  envValue: string | undefined,
): readonly string[] {
  if (envValue !== undefined && typeof envValue !== "string") {
    throw new TypeError("TAKOSUMI_ENABLED_RUNNER_PROFILES must be a string");
  }
  const ids = (envValue ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (ids.length === 0) return [DEFAULT_OPENTOFU_RUNNER_PROFILE_ID];

  const seen = new Set<string>();
  const parsed: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`duplicate enabled runner profile id ${id}`);
    }
    seen.add(id);
    parsed.push(id);
  }
  return parsed;
}

/**
 * Compare immutable execution identities by their owned coordinates rather
 * than object identity. Host composition and profile values cross bundle/
 * realm boundaries, so each field is checked explicitly.
 */
export function executionEvidenceAuthoritiesEqual(
  left: NonNullable<RunnerProfile["executionEvidenceAuthority"]>,
  right: NonNullable<RunnerProfile["executionEvidenceAuthority"]>,
): boolean {
  return (
    left.controllerArtifact.digest === right.controllerArtifact.digest &&
    left.controllerArtifact.immutable === right.controllerArtifact.immutable &&
    left.runnerArtifact.digest === right.runnerArtifact.digest &&
    left.runnerArtifact.immutable === right.runnerArtifact.immutable &&
    left.executorArtifact.digest === right.executorArtifact.digest &&
    left.executorArtifact.immutable === right.executorArtifact.immutable
  );
}

function assertRunnerProfileShape(
  value: unknown,
  index: number,
  options: Readonly<{
    readonly rejectUnknownKeys?: boolean;
    readonly requireCreatedAt?: boolean;
  }>,
): RunnerProfile {
  if (!isRecord(value)) {
    throw new TypeError(`runner profile at index ${index} must be an object`);
  }
  const id = requireProfileString(value.id, `runner profile at index ${index}.id`);
  if (id !== id.trim()) {
    throw new TypeError(`runner profile at index ${index}.id must be trimmed`);
  }
  if (options.rejectUnknownKeys) {
    assertClosedRecord(value, RUNNER_PROFILE_KEYS, `runner profile ${id}`);
  }
  requireProfileString(value.name, `runner profile ${id}.name`);
  requireProfileString(value.substrate, `runner profile ${id}.substrate`);
  requireProfileString(value.executorId, `runner profile ${id}.executorId`);
  assertLifecycle(value.lifecycle, id, options);
  assertAvailability(value.availability, id, options);
  assertStateBackend(value.stateBackend, id, options);
  assertStringArray(value.allowedProviders, `runner profile ${id}.allowedProviders`);
  assertOptionalStringArray(value.deniedProviders, `runner profile ${id}.deniedProviders`);
  if (
    value.requireProviderBindings !== undefined &&
    typeof value.requireProviderBindings !== "boolean"
  ) {
    throw new TypeError(
      `runner profile ${id}.requireProviderBindings must be a boolean`,
    );
  }
  assertOptionalStringArray(value.capabilities, `runner profile ${id}.capabilities`);
  if (value.description !== undefined) {
    requireProfileString(value.description, `runner profile ${id}.description`);
  }
  if (value.tofuVersion !== undefined) {
    requireProfileString(value.tofuVersion, `runner profile ${id}.tofuVersion`);
  }
  assertResourceLimits(value.resourceLimits, id, options);
  assertNetworkPolicy(value.networkPolicy, id, options);
  assertSecretExposurePolicy(value.secretExposurePolicy, id, options);
  if (
    value.concurrency !== undefined &&
    (!isFiniteNumber(value.concurrency) || value.concurrency <= 0)
  ) {
    throw new TypeError(`runner profile ${id}.concurrency must be positive`);
  }
  assertLabels(value.labels, id);
  assertExecutionEvidenceAuthority(value.executionEvidenceAuthority, id);
  if (options.requireCreatedAt && !isFiniteNumber(value.createdAt)) {
    throw new TypeError(`runner profile ${id}.createdAt must be a finite number`);
  }
  return value as unknown as RunnerProfile;
}

function assertLifecycle(
  value: unknown,
  id: string,
  options: Readonly<{ readonly rejectUnknownKeys?: boolean }>,
): void {
  if (!isRecord(value) || !PROFILE_LIFECYCLE_STATES.has(value.state as string)) {
    throw new TypeError(
      `runner profile ${id}.lifecycle.state must be candidate, active, or reserved`,
    );
  }
  if (isRecord(value) && options.rejectUnknownKeys) {
    assertClosedRecord(
      value,
      PROFILE_LIFECYCLE_KEYS,
      `runner profile ${id}.lifecycle`,
    );
  }
  assertOptionalReason(value.reason, `runner profile ${id}.lifecycle.reason`);
}

function assertAvailability(
  value: unknown,
  id: string,
  options: Readonly<{ readonly rejectUnknownKeys?: boolean }>,
): void {
  if (
    !isRecord(value) ||
    !PROFILE_AVAILABILITY_STATES.has(value.state as string)
  ) {
    throw new TypeError(
      `runner profile ${id}.availability.state must be available or unavailable`,
    );
  }
  if (isRecord(value) && options.rejectUnknownKeys) {
    assertClosedRecord(
      value,
      PROFILE_AVAILABILITY_KEYS,
      `runner profile ${id}.availability`,
    );
  }
  assertOptionalReason(value.reason, `runner profile ${id}.availability.reason`);
}

function assertStateBackend(
  value: unknown,
  id: string,
  options: Readonly<{ readonly rejectUnknownKeys?: boolean }>,
): void {
  if (!isRecord(value)) {
    throw new TypeError(`runner profile ${id}.stateBackend must be an object`);
  }
  if (options.rejectUnknownKeys) {
    assertClosedRecord(
      value,
      PROFILE_STATE_BACKEND_KEYS,
      `runner profile ${id}.stateBackend`,
    );
  }
  requireProfileString(value.kind, `runner profile ${id}.stateBackend.kind`);
  assertOptionalString(value.ref, `runner profile ${id}.stateBackend.ref`);
  if (value.lock !== undefined) {
    if (!isRecord(value.lock)) {
      throw new TypeError(`runner profile ${id}.stateBackend.lock must be an object`);
    }
    if (options.rejectUnknownKeys) {
      assertClosedRecord(
        value.lock,
        PROFILE_STATE_LOCK_KEYS,
        `runner profile ${id}.stateBackend.lock`,
      );
    }
    requireProfileString(value.lock.kind, `runner profile ${id}.stateBackend.lock.kind`);
    assertOptionalString(value.lock.ref, `runner profile ${id}.stateBackend.lock.ref`);
  }
}

function assertResourceLimits(
  value: unknown,
  id: string,
  options: Readonly<{ readonly rejectUnknownKeys?: boolean }>,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new TypeError(`runner profile ${id}.resourceLimits must be an object`);
  }
  if (options.rejectUnknownKeys) {
    assertClosedRecord(
      value,
      PROFILE_RESOURCE_LIMIT_KEYS,
      `runner profile ${id}.resourceLimits`,
    );
  }
  for (const field of [
    "maxRunSeconds",
    "maxSourceArchiveBytes",
    "maxSourceDecompressedBytes",
    "memoryMb",
  ] as const) {
    if (value[field] !== undefined && (!isFiniteNumber(value[field]) || value[field] <= 0)) {
      throw new TypeError(`runner profile ${id}.resourceLimits.${field} must be positive`);
    }
  }
  assertOptionalString(value.cpu, `runner profile ${id}.resourceLimits.cpu`);
}

function assertNetworkPolicy(
  value: unknown,
  id: string,
  options: Readonly<{ readonly rejectUnknownKeys?: boolean }>,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new TypeError(`runner profile ${id}.networkPolicy must be an object`);
  }
  if (options.rejectUnknownKeys) {
    assertClosedRecord(
      value,
      PROFILE_NETWORK_POLICY_KEYS,
      `runner profile ${id}.networkPolicy`,
    );
  }
  requireProfileString(value.mode, `runner profile ${id}.networkPolicy.mode`);
  assertOptionalStringArray(value.allowedHosts, `runner profile ${id}.networkPolicy.allowedHosts`);
  assertOptionalStringArray(
    value.allowedHostPatterns,
    `runner profile ${id}.networkPolicy.allowedHostPatterns`,
  );
}

function assertSecretExposurePolicy(
  value: unknown,
  id: string,
  options: Readonly<{ readonly rejectUnknownKeys?: boolean }>,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new TypeError(
      `runner profile ${id}.secretExposurePolicy must be an object`,
    );
  }
  if (options.rejectUnknownKeys) {
    assertClosedRecord(
      value,
      PROFILE_SECRET_EXPOSURE_KEYS,
      `runner profile ${id}.secretExposurePolicy`,
    );
  }
  if (!SECRET_PROVIDER_CREDENTIAL_EXPOSURES.has(value.providerCredentials as string)) {
    throw new TypeError(
      `runner profile ${id} declares unenforceable secretExposurePolicy.providerCredentials ` +
        `${String(value.providerCredentials)}; expected one of ${[
          ...SECRET_PROVIDER_CREDENTIAL_EXPOSURES,
        ].join(", ")}`,
    );
  }
  if (!SECRET_TENANT_OPERATOR_EXPOSURES.has(value.tenantWorkerOperatorSecrets as string)) {
    throw new TypeError(
      `runner profile ${id} declares unenforceable secretExposurePolicy.tenantWorkerOperatorSecrets ` +
        `${String(value.tenantWorkerOperatorSecrets)}; expected one of ${[
          ...SECRET_TENANT_OPERATOR_EXPOSURES,
        ].join(", ")}`,
    );
  }
  for (const field of ["redactLogs", "blockSensitiveOutputs"] as const) {
    if (value[field] !== undefined && value[field] !== true) {
      throw new TypeError(
        `runner profile ${id} cannot disable secretExposurePolicy.${field}; ` +
          "the runner boundary always redacts run material",
      );
    }
  }
}

function assertLabels(value: unknown, id: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new TypeError(`runner profile ${id}.labels must be an object`);
  }
  for (const [key, label] of Object.entries(value)) {
    if (typeof label !== "string") {
      throw new TypeError(`runner profile ${id}.labels.${key} must be a string`);
    }
  }
}

function assertExecutionEvidenceAuthority(value: unknown, id: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new TypeError(
      `runner profile ${id}.executionEvidenceAuthority must be an object`,
    );
  }
  const fields = ["controllerArtifact", "runnerArtifact", "executorArtifact"] as const;
  for (const field of fields) {
    const artifact = value[field];
    if (!isRecord(artifact) || artifact.immutable !== true) {
      throw new TypeError(
        `runner profile ${id}.executionEvidenceAuthority.${field} is invalid`,
      );
    }
    if (
      Reflect.ownKeys(artifact).some(
        (key) => key !== "digest" && key !== "immutable",
      )
    ) {
      throw new TypeError(
        `runner profile ${id}.executionEvidenceAuthority.${field} is invalid`,
      );
    }
    if (
      typeof artifact.digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest)
    ) {
      throw new TypeError(
        `runner profile ${id}.executionEvidenceAuthority.${field} is invalid`,
      );
    }
  }
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !fields.includes(key as (typeof fields)[number]),
    )
  ) {
    throw new TypeError(`runner profile ${id}.executionEvidenceAuthority is not closed`);
  }
}

function assertClosedRecord(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknownKeys = Reflect.ownKeys(value).filter(
    (key) => typeof key !== "string" || !allowed.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `${label} has unknown key ${unknownKeys.map((key) => String(key)).join(", ")}`,
    );
  }
}

function assertStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim())) {
    throw new TypeError(`${label} must be a string array`);
  }
}

function assertOptionalStringArray(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim())) {
    throw new TypeError(`${label} must be a string array`);
  }
}

function requireProfileString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
}

function assertOptionalReason(value: unknown, label: string): void {
  assertOptionalString(value, label);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activateRequestedProfile(profile: RunnerProfile): RunnerProfile {
  assertRunnerProfileAvailable(profile);
  if (profile.lifecycle.state === "active") return profile;
  return {
    ...profile,
    lifecycle: { state: "active" },
  };
}

export function createDefaultRunnerProfiles(
  now = Date.now(),
): readonly RunnerProfile[] {
  return [createDefaultOpenTofuRunnerProfile(now)];
}

const DEFAULT_RESOURCE_LIMITS: NonNullable<RunnerProfile["resourceLimits"]> = {
  maxRunSeconds: 900,
  maxSourceArchiveBytes: 100 * 1024 * 1024,
  maxSourceDecompressedBytes: 1000 * 1024 * 1024,
  cpu: "1",
  memoryMb: 1024,
};

const DEFAULT_SECRET_EXPOSURE_POLICY: NonNullable<
  RunnerProfile["secretExposurePolicy"]
> = {
  providerCredentials: "runner-only",
  tenantWorkerOperatorSecrets: "forbidden",
  redactLogs: true,
  blockSensitiveOutputs: true,
};

function createDefaultOpenTofuRunnerProfile(now: number): RunnerProfile {
  const id = DEFAULT_OPENTOFU_RUNNER_PROFILE_ID;
  return {
    id,
    name: "OpenTofu default",
    substrate: "operator-managed",
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
    description:
      "Isolated provider-neutral runner for plain OpenTofu modules. Provider packages use the configured mirror/cache when present and the OpenTofu registry path otherwise.",
    tofuVersion: "operator-managed",
    stateBackend: {
      kind: "operator-managed",
      ref: `state://takosumi/${id}`,
      lock: {
        kind: "operator",
        ref: `lock://takosumi/${id}`,
      },
    },
    capabilities: [CAPSULE_LIFECYCLE_COMMAND_CAPABILITY],
    allowedProviders: ["*"],
    requireProviderBindings: false,
    resourceLimits: DEFAULT_RESOURCE_LIMITS,
    // The runner host enforces public-egress isolation. Private, link-local,
    // metadata, control-plane, or host-socket access requires a separate
    // operator-defined execution profile.
    networkPolicy: { mode: "operator-managed" },
    secretExposurePolicy: DEFAULT_SECRET_EXPOSURE_POLICY,
    createdAt: now,
  };
}

function assertRunnerProfileAvailable(profile: RunnerProfile): void {
  if (!profile.executorId?.trim()) {
    throw new Error(`runner profile ${profile.id} requires executorId`);
  }
  if (!profile.lifecycle) {
    throw new Error(`runner profile ${profile.id} requires lifecycle`);
  }
  if (!profile.availability) {
    throw new Error(`runner profile ${profile.id} requires availability`);
  }
  if (
    profile.lifecycle.state !== "active" &&
    profile.lifecycle.state !== "candidate" &&
    profile.lifecycle.state !== "reserved"
  ) {
    throw new Error(
      `runner profile ${profile.id} has invalid lifecycle state ${String(profile.lifecycle.state)}`,
    );
  }
  if (profile.availability.state !== "available") {
    throw new Error(
      `runner profile ${profile.id} is unavailable` +
        (profile.availability.reason ? `: ${profile.availability.reason}` : ""),
    );
  }
  assertEnforceableSecretExposurePolicy(profile);
  if (profile.lifecycle.state !== "reserved") return;
  throw new Error(
    `runner profile ${profile.id} is reserved and cannot be activated` +
      (profile.lifecycle.reason ? `: ${profile.lifecycle.reason}` : ""),
  );
}

/**
 * A secret exposure policy is a promise about what reaches the runner, so a
 * value the boundary does not implement must never be activated: an operator
 * writing something stricter-sounding than the enforced set would otherwise
 * trust a declaration nothing reads. Redaction and sensitive-output blocking
 * are unconditional at the runner boundary and cannot be turned off here.
 */
function assertEnforceableSecretExposurePolicy(profile: RunnerProfile): void {
  const policy = profile.secretExposurePolicy;
  if (!policy) return;
  if (!PROVIDER_CREDENTIAL_EXPOSURES.has(policy.providerCredentials)) {
    throw new Error(
      `runner profile ${profile.id} declares unenforceable secretExposurePolicy.providerCredentials ` +
        `${String(policy.providerCredentials)}; expected one of ${[...PROVIDER_CREDENTIAL_EXPOSURES].join(", ")}`,
    );
  }
  if (
    !TENANT_WORKER_OPERATOR_SECRET_EXPOSURES.has(
      policy.tenantWorkerOperatorSecrets,
    )
  ) {
    throw new Error(
      `runner profile ${profile.id} declares unenforceable secretExposurePolicy.tenantWorkerOperatorSecrets ` +
        `${String(policy.tenantWorkerOperatorSecrets)}; expected one of ${[...TENANT_WORKER_OPERATOR_SECRET_EXPOSURES].join(", ")}`,
    );
  }
  for (const field of ["redactLogs", "blockSensitiveOutputs"] as const) {
    const value = policy[field];
    if (value === undefined || value === true) continue;
    throw new Error(
      `runner profile ${profile.id} cannot disable secretExposurePolicy.${field}; ` +
        `the runner boundary always redacts run material`,
    );
  }
}

const PROVIDER_CREDENTIAL_EXPOSURES: ReadonlySet<string> = new Set([
  "runner-only",
  "operator-managed",
  "forbidden",
]);

const TENANT_WORKER_OPERATOR_SECRET_EXPOSURES: ReadonlySet<string> = new Set([
  "forbidden",
  "tenant-scoped-references-only",
  "operator-managed",
]);
