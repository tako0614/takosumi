import type { Shape, ShapeValidationIssue } from "takosumi-contract";
import {
  isNonEmptyString,
  isRecord,
  optionalNonEmptyString,
  optionalStringRecord,
  requireNonEmptyString,
  requireRoot,
} from "./_validators.ts";
import {
  WORKER_CAPABILITIES,
  WORKER_DESCRIPTION,
  WORKER_KIND_ID,
  WORKER_KIND_VERSION,
  WORKER_OUTPUT_FIELDS,
  type WorkerCapability,
  type WorkerOutputs,
  type WorkerSpec,
} from "./worker.generated.ts";

export type { WorkerCapability, WorkerOutputs, WorkerSpec };

/**
 * `worker@v1` component kind descriptor. Materialized by a provider plugin
 * (cloudflare-workers / deno-deploy / etc.) at apply time.
 *
 * Spec / outputs / capabilities are derived from
 * `spec/contexts/kinds/v1/worker.jsonld` via `worker.generated.ts`;
 * validation diagnostics are hand-written below.
 */
export const WorkerKind: Shape<WorkerSpec, WorkerOutputs, WorkerCapability> = {
  id: WORKER_KIND_ID,
  version: WORKER_KIND_VERSION,
  description: WORKER_DESCRIPTION,
  capabilities: WORKER_CAPABILITIES,
  outputFields: WORKER_OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;
    validateArtifact(value.artifact, issues);
    requireNonEmptyString(
      value.compatibilityDate,
      "$.compatibilityDate",
      issues,
    );
    validateStringArray(
      value.compatibilityFlags,
      "$.compatibilityFlags",
      issues,
    );
    optionalStringRecord(value.env, "$.env", issues);
    validateStringArray(value.routes, "$.routes", issues);
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.url, "$.url", issues);
    requireNonEmptyString(value.scriptName, "$.scriptName", issues);
    optionalNonEmptyString(value.version, "$.version", issues);
  },
};

/**
 * `worker@v1` only accepts uploaded `js-bundle` artifacts: `kind` must be
 * exactly `"js-bundle"` and `hash` is required (no external `uri`).
 */
function validateArtifact(
  value: unknown,
  issues: ShapeValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path: "$.artifact", message: "must be an object" });
    return;
  }
  if (!isNonEmptyString(value.kind)) {
    issues.push({
      path: "$.artifact.kind",
      message: "must be a non-empty string",
    });
  } else if (value.kind !== "js-bundle") {
    issues.push({
      path: "$.artifact.kind",
      message: "must be `js-bundle` for worker@v1",
    });
  }
  if (!isNonEmptyString(value.hash)) {
    issues.push({
      path: "$.artifact.hash",
      message: "must be a non-empty string (js-bundle requires upload hash)",
    });
  }
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return;
  }
  if (!value.every(isNonEmptyString)) {
    issues.push({ path, message: "must contain only non-empty strings" });
  }
}
