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
} from "takosumi-contract/deploy-control-api";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";
import { redactString } from "../../services/observability/redaction.ts";

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
  if (!outputs) return [];
  const byName = outputValuesByName(outputs);
  const result: DeploymentOutput[] = [];
  for (const [publicName, spec] of Object.entries(template.outputs.public)) {
    const entry = byName.get(publicName);
    if (!entry || entry.sensitive) continue;
    const kind = templateOutputKind(spec.type);
    if (!isPublishableDeploymentOutputValue(publicName, kind, entry.value)) {
      continue;
    }
    result.push({ name: publicName, kind, value: entry.value, sensitive: false });
  }
  return result;
}

function outputValuesByName(
  outputs: OpenTofuOutputEnvelope | readonly DeploymentOutput[],
): ReadonlyMap<string, { readonly value: JsonValue; readonly sensitive: boolean }> {
  const map = new Map<string, { value: JsonValue; sensitive: boolean }>();
  if (Array.isArray(outputs as unknown)) {
    for (const output of outputs as readonly DeploymentOutput[]) {
      map.set(output.name, { value: output.value, sensitive: output.sensitive });
    }
    return map;
  }
  for (const [name, output] of Object.entries(outputs as OpenTofuOutputEnvelope)) {
    map.set(name, { value: output.value, sensitive: output.sensitive === true });
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

export function normalizeDeploymentOutputs(
  outputs: OpenTofuOutputEnvelope | readonly DeploymentOutput[] | undefined,
): readonly DeploymentOutput[] {
  if (!outputs) return [];
  if (Array.isArray(outputs as unknown)) {
    return (outputs as readonly DeploymentOutput[]).filter((output) =>
      output.sensitive === false &&
      isPublishableDeploymentOutputValue(output.name, output.kind, output.value)
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
    ...(typeof summary.destroy === "number" ? { destroy: summary.destroy } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function outputKindFromName(name: string): DeploymentOutput["kind"] | undefined {
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
  if (typeof value !== "string") return true;
  if (!kind.endsWith("_url")) return !SECRET_QUERY_RE.test(value);
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
  return {
    severity: "error",
    message: errorMessage(error),
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
