/**
 * Output / diagnostic projection and redaction for the deploy-control domain.
 *
 * These pure functions derive two deliberately separate views from runner
 * results: bounded Workspace-local Output capture, which treats ordinary
 * non-sensitive values as opaque data, and an explicit public projection,
 * which additionally applies publishability filtering. They also normalize
 * plan artifacts/summaries, state-lock evidence, and diagnostics.
 */

import type { JsonValue } from "takosumi-contract";
import type {
  OpenTofuOutputEnvelope,
  OpenTofuPlanArtifact,
  PlanRunSummary,
  RunDiagnostic,
  RunnerStateBackend,
  RunnerStateLockEvidence,
} from "@takosumi/internal/deploy-control-api";
import type {
  OutputAllowlistEntry,
  OutputValueType,
} from "takosumi-contract/install-configs";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
  structuredErrorReason,
} from "./errors.ts";
import {
  containsSecretLikeString,
  redactString,
} from "takosumi-contract/redaction";

/**
 * Keeps the cleartext Workspace-local Output row bounded. The raw encrypted
 * runner artifact remains the complete source of record; values outside these
 * limits are simply unavailable to Dependency/Interface resolution unless the
 * module exposes a smaller ordinary Output.
 */
export const WORKSPACE_OUTPUT_PROJECTION_LIMITS = {
  maxEntries: 128,
  maxValueBytes: 64 * 1024,
  maxTotalBytes: 256 * 1024,
} as const;

export function projectOutputAllowlistPublicOutputs(
  outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>,
  outputs: OpenTofuOutputEnvelope | undefined,
): Readonly<Record<string, JsonValue>> {
  const projected = projectOutputAllowlistSpaceOutputs(
    outputAllowlist,
    outputs,
  );
  const result: Record<string, JsonValue> = {};
  for (const [publicName, spec] of Object.entries(outputAllowlist)) {
    if (!(publicName in projected)) continue;
    const kind = projectionOutputKind(spec.type);
    const value = projected[publicName]!;
    if (
      !isPublishableOutputValue(publicName, kind, value) ||
      !isPublishableOutputValue(spec.from, kind, value)
    ) {
      if (spec.required) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `required output ${spec.from} cannot be published as ${publicName}`,
        );
      }
      continue;
    }
    result[publicName] = value;
  }
  return result;
}

export function projectOutputAllowlistSpaceOutputs(
  outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>,
  outputs: OpenTofuOutputEnvelope | undefined,
): Readonly<Record<string, JsonValue>> {
  const byName = outputs ? outputValuesByName(outputs) : new Map();
  const result: Record<string, JsonValue> = {};
  let projectedCount = 0;
  let projectedBytes = 0;
  const entries = Object.entries(outputAllowlist).sort(
    ([leftName, left], [rightName, right]) =>
      Number(right.required === true) - Number(left.required === true) ||
      leftName.localeCompare(rightName),
  );
  for (const [projectedName, spec] of entries) {
    if (spec.sensitive === true) {
      continue;
    }
    const entry = byName.get(spec.from);
    if (!entry) {
      if (spec.required) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `required output ${spec.from} is missing for projection ${projectedName}`,
        );
      }
      continue;
    }
    if (entry.sensitive) {
      if (spec.required) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `required output ${spec.from} is sensitive and cannot be projected as ${projectedName}`,
        );
      }
      continue;
    }
    if ((entry.value === "" || entry.value === null) && !spec.required) {
      continue;
    }
    if (!outputValueMatchesType(entry.value, spec.type)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `output ${spec.from} does not match declared projection type ${spec.type} (actual ${describeJsonValueType(entry.value)})`,
      );
    }
    const valueBytes = jsonValueUtf8Bytes(entry.value);
    const projectedEntryBytes =
      jsonValueUtf8Bytes(projectedName) + valueBytes + 2;
    if (
      valueBytes > WORKSPACE_OUTPUT_PROJECTION_LIMITS.maxValueBytes ||
      projectedCount >= WORKSPACE_OUTPUT_PROJECTION_LIMITS.maxEntries ||
      projectedBytes + projectedEntryBytes >
        WORKSPACE_OUTPUT_PROJECTION_LIMITS.maxTotalBytes
    ) {
      if (spec.required) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `required output ${spec.from} exceeds the Workspace Output projection limits`,
        );
      }
      continue;
    }
    result[projectedName] = entry.value;
    projectedCount += 1;
    projectedBytes += projectedEntryBytes;
  }
  return result;
}

/**
 * Default Workspace capture for an ordinary root module. This is intentionally
 * not a public allowlist: every bounded, non-sensitive root Output is retained
 * as an OpenTofu return value. Public projection remains DB-explicit.
 */
export function projectAllWorkspaceOutputs(
  outputs: OpenTofuOutputEnvelope | undefined,
): Readonly<Record<string, JsonValue>> {
  const result: Record<string, JsonValue> = {};
  if (!outputs) return result;
  let projectedCount = 0;
  let projectedBytes = 0;
  const entries = [...outputValuesByName(outputs).entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  );
  for (const [name, entry] of entries) {
    if (entry.sensitive) continue;
    const valueBytes = jsonValueUtf8Bytes(entry.value);
    const projectedEntryBytes = jsonValueUtf8Bytes(name) + valueBytes + 2;
    if (
      valueBytes > WORKSPACE_OUTPUT_PROJECTION_LIMITS.maxValueBytes ||
      projectedCount >= WORKSPACE_OUTPUT_PROJECTION_LIMITS.maxEntries ||
      projectedBytes + projectedEntryBytes >
        WORKSPACE_OUTPUT_PROJECTION_LIMITS.maxTotalBytes
    ) {
      continue;
    }
    result[name] = entry.value;
    projectedCount += 1;
    projectedBytes += projectedEntryBytes;
  }
  return result;
}

function jsonValueUtf8Bytes(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function outputValuesByName(
  outputs: OpenTofuOutputEnvelope,
): ReadonlyMap<
  string,
  { readonly value: JsonValue; readonly sensitive: boolean }
> {
  const map = new Map<string, { value: JsonValue; sensitive: boolean }>();
  for (const [name, output] of Object.entries(outputs)) {
    map.set(name, {
      value: output.value,
      sensitive: output.sensitive === true,
    });
  }
  return map;
}

/**
 * Maps an explicit service-side public-output type to a display kind.
 * The declared type, rather than the Output name, determines URL semantics.
 */
function projectionOutputKind(type: string): string {
  return typeof type === "string" && type.length > 0 ? type : "string";
}

function outputValueMatchesType(
  value: JsonValue,
  type: OutputAllowlistEntry["type"],
): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "url":
      if (typeof value !== "string") return false;
      try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" || parsed.protocol === "http:";
      } catch {
        return false;
      }
    case "hostname":
      return (
        typeof value === "string" &&
        /^[a-z0-9.-]+$/i.test(value) &&
        !value.includes("..")
      );
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "json":
      return true;
  }
}

function describeJsonValueType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function normalizePlanArtifact(input: {
  readonly artifact: OpenTofuPlanArtifact;
  readonly planDigest: string;
  readonly now: number;
}): OpenTofuPlanArtifact {
  requireNonEmptyString(input.artifact.ref, "planArtifact.ref");
  requireNonEmptyString(input.artifact.digest, "planArtifact.digest");
  if (input.artifact.digest !== input.planDigest) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "planArtifact.digest must match planDigest",
    );
  }
  return {
    kind: input.artifact.kind || "runner-local",
    ref: input.artifact.ref,
    digest: input.artifact.digest,
    ...(input.artifact.contentType
      ? { contentType: input.artifact.contentType }
      : {}),
    ...(input.artifact.sizeBytes !== undefined
      ? { sizeBytes: input.artifact.sizeBytes }
      : {}),
    createdAt: input.artifact.createdAt ?? input.now,
  };
}

export function normalizePlanSummary(
  summary: PlanRunSummary | undefined,
): PlanRunSummary | undefined {
  if (!summary) return undefined;
  const normalized: PlanRunSummary = {
    ...(typeof summary.add === "number" ? { add: summary.add } : {}),
    ...(typeof summary.change === "number" ? { change: summary.change } : {}),
    ...(typeof summary.destroy === "number"
      ? { destroy: summary.destroy }
      : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

const SECRET_OUTPUT_NAME_RE =
  /(?:^|[_-])(token|secret|password|passwd|credential|auth|bearer|session|cookie|key)(?:$|[_-])/i;
const SECRET_QUERY_RE =
  /(?:token|secret|password|passwd|credential|auth|bearer|session|cookie|key)/i;

function isPublishableOutputValue(
  name: string,
  kind: string,
  value: JsonValue,
): boolean {
  if (SECRET_OUTPUT_NAME_RE.test(name)) return false;
  if (typeof value !== "string") {
    return !containsSecretLikeJsonValue(value);
  }
  if (containsSecretLikeString(value) || redactString(value) !== value) {
    return false;
  }
  if (kind !== "url") return true;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.username || parsed.password) return false;
  for (const key of parsed.searchParams.keys()) {
    if (SECRET_QUERY_RE.test(key)) return false;
  }
  return true;
}

function containsSecretLikeJsonValue(value: JsonValue): boolean {
  const stack: JsonValue[] = [value];
  let inspected = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    inspected += 1;
    if (inspected > 1_000) return true;
    if (typeof current === "string") {
      if (
        containsSecretLikeString(current) ||
        redactString(current) !== current
      ) {
        return true;
      }
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    for (const [key, nested] of Object.entries(current)) {
      if (SECRET_QUERY_RE.test(key) || SECRET_OUTPUT_NAME_RE.test(key)) {
        return true;
      }
      stack.push(nested);
    }
  }
  return false;
}

export function stateLockEvidence(
  stateBackend: RunnerStateBackend,
  acquiredAt: number,
  releasedAt: number,
  status: RunnerStateLockEvidence["status"],
): RunnerStateLockEvidence {
  const backendRef = stateBackend.ref ?? stateBackend.kind;
  const lock = stateBackend.lock;
  if (!lock || lock.kind === "none") {
    return {
      status: "not_required",
      backendRef,
      acquiredAt,
      releasedAt,
    };
  }
  return {
    status,
    backendRef,
    ...(lock.ref ? { lockRef: lock.ref } : {}),
    acquiredAt,
    ...(status === "recorded" ? { releasedAt } : {}),
  };
}

export function errorDiagnostic(error: unknown): RunDiagnostic {
  const message = errorMessage(error);
  const code = structuredErrorReason(error);
  return {
    severity: "error",
    ...(code ? { code } : {}),
    message,
  };
}

export function errorMessage(error: unknown): string {
  return redactString(error instanceof Error ? error.message : String(error));
}

export function redactRunDiagnostics(
  diagnostics: readonly RunDiagnostic[] | undefined,
): readonly RunDiagnostic[] | undefined {
  if (!diagnostics) return undefined;
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    message: redactString(diagnostic.message),
    ...(diagnostic.detail === undefined
      ? {}
      : { detail: redactString(diagnostic.detail) }),
  }));
}
