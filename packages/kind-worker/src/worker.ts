import type {
  Shape,
  ShapeValidationIssue,
} from "takosumi-contract/reference/shape";
import {
  isNonEmptyString,
  optionalNonEmptyString,
  optionalStringRecord,
  requireNonEmptyString,
  requireRoot,
} from "./_validators.ts";
import {
  WORKER_CAPABILITY_TERMS,
  WORKER_DESCRIPTION,
  WORKER_KIND_SHAPE_ID,
  WORKER_KIND_VERSION,
  WORKER_OUTPUT_FIELDS,
  type WorkerCapabilityTerm,
  type WorkerOutputs,
  type WorkerSpec,
} from "./worker.generated.ts";

export type { WorkerCapabilityTerm, WorkerOutputs, WorkerSpec };

/**
 * `worker@v1` component kind descriptor. Materialized by a backend adapter
 * (Cloudflare Workers / Deno Deploy / etc.) at apply time.
 *
 * Spec / outputs / capability terms are derived from
 * `packages/kind-worker/spec/kind.jsonld` via `worker.generated.ts`;
 * validation diagnostics are hand-written below.
 */
export const WorkerKind: Shape<
  WorkerSpec,
  WorkerOutputs,
  WorkerCapabilityTerm
> = {
  id: WORKER_KIND_SHAPE_ID,
  version: WORKER_KIND_VERSION,
  description: WORKER_DESCRIPTION,
  capabilityTerms: WORKER_CAPABILITY_TERMS,
  outputFields: WORKER_OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;
    validateEntrypoint(value.entrypoint, issues);
    optionalNonEmptyString(
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
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.url, "$.url", issues);
    requireNonEmptyString(value.id, "$.id", issues);
    optionalNonEmptyString(value.version, "$.version", issues);
  },
};

function validateEntrypoint(
  value: unknown,
  issues: ShapeValidationIssue[],
): void {
  if (!isNonEmptyString(value)) {
    issues.push({
      path: "$.entrypoint",
      message: "must be a non-empty source-root-relative path",
    });
    return;
  }
  if (value.startsWith("/") || value.split("/").includes("..")) {
    issues.push({
      path: "$.entrypoint",
      message: "must not be absolute or escape the source root",
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
