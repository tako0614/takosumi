/**
 * Output / diagnostic projection and redaction for the deploy-control domain.
 *
 * These pure functions derive the public, non-secret ledger projection from
 * runner results: well-known DeploymentOutput selection + secret filtering,
 * plan artifact/summary normalization, state-lock evidence, and diagnostic
 * redaction. Secret outputs and references never reach the public ledger.
 */

import type { JsonValue } from "takosumi-contract";
import type {
  DeploymentOutput,
  OpenTofuOutputEnvelope,
  OpenTofuPlanArtifact,
  PlanRunSummary,
  RunDiagnostic,
  RunnerStateBackend,
  RunnerStateLockEvidence,
  TemplateDefinition,
} from "@takosumi/internal/deploy-control-api";
import type {
  OutputAllowlistEntry,
  OutputValueType,
} from "takosumi-contract/install-configs";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";
import {
  containsSecretLikeString,
  redactString,
} from "takosumi-contract/redaction";

export function deploymentOutputsFromOpenTofu(
  outputs: OpenTofuOutputEnvelope,
): readonly DeploymentOutput[] {
  const result: DeploymentOutput[] = [];
  for (const [name, output] of Object.entries(outputs)) {
    if (output.sensitive === true) continue;
    const kind = outputKindFromName(name);
    if (!kind) continue;
    if (!isPublishableDeploymentOutputValue(name, kind, output.value)) continue;
    result.push({
      name,
      kind,
      value: output.value,
      sensitive: false,
    });
  }
  return result;
}

/**
 * Template output allowlist projection (Phase 1C).
 *
 * For a template-backed run, project ONLY the template's declared public
 * outputs. The Takosumi-generated root re-exports each public output under its
 * public name (`output "<public>" { value = module.app.<from> }`), so the runner
 * output envelope is keyed by the public names. We keep only those names, drop
 * sensitive/non-publishable values via the same filter as the well-known
 * projection, and stamp the template-declared display kind.
 */
export function projectTemplatePublicOutputs(
  template: TemplateDefinition,
  outputs: OpenTofuOutputEnvelope | readonly DeploymentOutput[] | undefined,
): readonly DeploymentOutput[] {
  if (!outputs) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      `template ${template.id}@${template.version} produced no OpenTofu outputs`,
    );
  }
  const byName = outputValuesByName(outputs);
  const result: DeploymentOutput[] = [];
  for (const [publicName, spec] of Object.entries(template.outputs.public)) {
    const entry = byName.get(publicName);
    if (!entry) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `template ${template.id}@${template.version} output ${publicName} is missing`,
      );
    }
    if (entry.sensitive) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `template ${template.id}@${template.version} output ${publicName} is sensitive and cannot be published`,
      );
    }
    const kind = templateOutputKind(spec.type);
    if (!templateOutputValueMatchesType(entry.value, spec.type)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `template ${template.id}@${template.version} output ${publicName} does not match declared type ${spec.type}`,
      );
    }
    if (!isPublishableDeploymentOutputValue(publicName, kind, entry.value)) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `template ${template.id}@${template.version} output ${publicName} cannot be published`,
      );
    }
    result.push({
      name: publicName,
      kind,
      value: entry.value,
      sensitive: false,
    });
  }
  return result;
}

export function projectOutputAllowlistPublicOutputs(
  outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>,
  outputs: OpenTofuOutputEnvelope | readonly DeploymentOutput[] | undefined,
): readonly DeploymentOutput[] {
  const projected = projectOutputAllowlistSpaceOutputs(
    outputAllowlist,
    outputs,
  );
  const result: DeploymentOutput[] = [];
  for (const [publicName, spec] of Object.entries(outputAllowlist)) {
    if (publicName === "takosumi_release") continue;
    if (!(publicName in projected)) continue;
    const kind = templateOutputKind(spec.type);
    const value = projected[publicName]!;
    if (!isPublishableDeploymentOutputValue(publicName, kind, value)) {
      if (spec.required) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `required output ${spec.from} cannot be published as ${publicName}`,
        );
      }
      continue;
    }
    result.push({ name: publicName, kind, value, sensitive: false });
  }
  return result;
}

export function projectOutputAllowlistSpaceOutputs(
  outputAllowlist: Readonly<Record<string, OutputAllowlistEntry>>,
  outputs: OpenTofuOutputEnvelope | readonly DeploymentOutput[] | undefined,
): Readonly<Record<string, JsonValue>> {
  const byName = outputs ? outputValuesByName(outputs) : new Map();
  const result: Record<string, JsonValue> = {};
  for (const [projectedName, spec] of Object.entries(outputAllowlist)) {
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
    if (
      !isPublishableDeploymentOutputValue(projectedName, spec.type, entry.value)
    ) {
      if (spec.required) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          `required output ${spec.from} cannot be projected as ${projectedName}`,
        );
      }
      continue;
    }
    result[projectedName] = entry.value;
  }
  return result;
}

function outputValuesByName(
  outputs: OpenTofuOutputEnvelope | readonly DeploymentOutput[],
): ReadonlyMap<
  string,
  { readonly value: JsonValue; readonly sensitive: boolean }
> {
  const map = new Map<string, { value: JsonValue; sensitive: boolean }>();
  if (Array.isArray(outputs as unknown)) {
    for (const output of outputs as readonly DeploymentOutput[]) {
      map.set(output.name, {
        value: output.value,
        sensitive: output.sensitive,
      });
    }
    return map;
  }
  for (const [name, output] of Object.entries(
    outputs as OpenTofuOutputEnvelope,
  )) {
    map.set(name, {
      value: output.value,
      sensitive: output.sensitive === true,
    });
  }
  return map;
}

/**
 * Maps a template public-output type hint to a DeploymentOutput display kind.
 * A `*_url`-shaped public name keeps URL semantics so the sensitive-URL guard in
 * `isPublishableDeploymentOutputValue` applies; everything else is a generic
 * non-URL value passed through under its declared type.
 */
function templateOutputKind(type: string): DeploymentOutput["kind"] {
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

function templateOutputValueMatchesType(
  value: JsonValue,
  type: string,
): boolean {
  return isOutputValueType(type) ? outputValueMatchesType(value, type) : true;
}

function isOutputValueType(type: string): type is OutputValueType {
  return (
    type === "string" ||
    type === "url" ||
    type === "hostname" ||
    type === "number" ||
    type === "boolean" ||
    type === "json"
  );
}

export function normalizeDeploymentOutputs(
  outputs: OpenTofuOutputEnvelope | readonly DeploymentOutput[] | undefined,
): readonly DeploymentOutput[] {
  if (!outputs) return [];
  if (Array.isArray(outputs as unknown)) {
    return (outputs as readonly DeploymentOutput[]).filter(
      (output) =>
        output.sensitive === false &&
        isPublishableDeploymentOutputValue(
          output.name,
          output.kind,
          output.value,
        ),
    );
  }
  return deploymentOutputsFromOpenTofu(outputs as OpenTofuOutputEnvelope);
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

function outputKindFromName(
  name: string,
): DeploymentOutput["kind"] | undefined {
  const normalized = name.replace(/^takosumi_/, "");
  switch (normalized) {
    case "launch_url":
    case "admin_url":
    case "health_url":
    case "docs_url":
    case "service_url":
      return normalized;
    default:
      return undefined;
  }
}

const SECRET_OUTPUT_NAME_RE =
  /(?:^|[_-])(token|secret|password|passwd|credential|auth|bearer|session|cookie|key)(?:$|[_-])/i;
const SECRET_QUERY_RE =
  /(?:token|secret|password|passwd|credential|auth|bearer|session|cookie|key)/i;

function isPublishableDeploymentOutputValue(
  name: string,
  kind: DeploymentOutput["kind"],
  value: JsonValue,
): boolean {
  if (SECRET_OUTPUT_NAME_RE.test(name)) return false;
  if (typeof value !== "string") {
    if (name === "app_deployment" && kind === "json") {
      return !containsUnsafeAppDeploymentDescriptorValue(value);
    }
    return !containsSecretLikeJsonValue(value);
  }
  if (containsSecretLikeString(value) || redactString(value) !== value) {
    return false;
  }
  if (!kind.endsWith("_url")) return true;
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

function containsUnsafeAppDeploymentDescriptorValue(value: JsonValue): boolean {
  return containsSecretLikeAppDeploymentDescriptorValue(value);
}

function containsSecretLikeAppDeploymentDescriptorValue(
  value: JsonValue,
): boolean {
  const stack: Array<{ value: JsonValue; path: readonly string[] }> = [
    { value, path: [] },
  ];
  let inspected = 0;
  while (stack.length > 0) {
    const { value: current, path } = stack.pop()!;
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
      for (const [index, item] of current.entries()) {
        stack.push({ value: item, path: [...path, String(index)] });
      }
      continue;
    }
    for (const [key, nested] of Object.entries(current)) {
      if (isDeclarativeConsumeEnvProjection(path, key, nested)) continue;
      if (SECRET_QUERY_RE.test(key) || SECRET_OUTPUT_NAME_RE.test(key)) {
        return true;
      }
      stack.push({ value: nested, path: [...path, key] });
    }
  }
  return false;
}

function isDeclarativeConsumeEnvProjection(
  path: readonly string[],
  key: string,
  value: JsonValue,
): boolean {
  if (typeof value !== "string") return false;
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key)) return false;
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(value)) return false;
  const tail = path.slice(-3);
  return (
    tail.length === 3 &&
    /^\d+$/u.test(tail[0] ?? "") &&
    tail[1] === "inject" &&
    tail[2] === "env"
  );
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
  const classified = classifiedErrorDiagnostic(message);
  if (classified) return classified;
  return {
    severity: "error",
    message,
  };
}

export function errorMessage(error: unknown): string {
  return redactString(error instanceof Error ? error.message : String(error));
}

function classifiedErrorDiagnostic(message: string): RunDiagnostic | undefined {
  if (isCreditRequiredErrorMessage(message)) {
    return {
      severity: "error",
      message:
        "credits_required: insufficient credits for this Takosumi Cloud operation",
      detail: message,
    };
  }
  if (isProviderConnectionNotReadyErrorMessage(message)) {
    return {
      severity: "error",
      message:
        "provider_connection_not_ready: connected account verification is required",
      detail: message,
    };
  }
  if (isProviderConnectionChangedErrorMessage(message)) {
    return {
      severity: "error",
      message:
        "provider_connection_changed: connected account evidence changed after planning",
      detail: message,
    };
  }
  if (isProviderConnectionSetupErrorMessage(message)) {
    return {
      severity: "error",
      message:
        "provider_connection_setup_required: connected account setup is required",
      detail: message,
    };
  }
  if (isCredentialServiceUnavailableErrorMessage(message)) {
    return {
      severity: "error",
      message:
        "credential_service_unavailable: provider credential preparation is unavailable",
      detail: message,
    };
  }
  return undefined;
}

function isCreditRequiredErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("cloud_extension_insufficient_credits") ||
    normalized.includes('"reason":"insufficient_credits"') ||
    normalized.includes('"reason": "insufficient_credits"') ||
    (normalized.includes("reservationstatus") &&
      normalized.includes("insufficient_credits")) ||
    normalized.includes("usd balance reservation failed") ||
    normalized.includes("insufficient credits")
  );
}

function isProviderConnectionChangedErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("resolved_bindings_changed") ||
    normalized.includes("re-plan before apply")
  );
}

function isProviderConnectionNotReadyErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    (normalized.includes("credential_mint_failed") &&
      normalized.includes("not verified")) ||
    normalized.includes("pending (not verified)") ||
    (normalized.includes("provider connection") &&
      normalized.includes("status pending is not verified"))
  );
}

function isProviderConnectionSetupErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("credential_mint_failed") &&
    (normalized.includes("provider connection evidence is required") ||
      normalized.includes("provider connection resolution is required") ||
      normalized.includes("root-only provider connection is required") ||
      (normalized.includes("connection ") &&
        normalized.includes(" not found")) ||
      normalized.includes("provider connection is required") ||
      normalized.includes("belongs to another space") ||
      normalized.includes("git source connection") ||
      normalized.includes("cannot back a provider env binding") ||
      (normalized.includes("provider ") &&
        normalized.includes(" does not match")))
  );
}

function isCredentialServiceUnavailableErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("credential_mint_failed") &&
    (normalized.includes("connection vault is not configured") ||
      normalized.includes("requires a managed provider credential issuer") ||
      normalized.includes("could not mint a run-scoped provider token") ||
      normalized.includes("gateway materialization is takosumi cloud-only") ||
      normalized.includes("mint driver"))
  );
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
