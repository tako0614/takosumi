import type { Shape, ShapeValidationIssue } from "takosumi-contract";
import {
  isNonEmptyString,
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
 * `packages/plugins/spec/kinds/v1/worker.jsonld` via `worker.generated.ts`;
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
    validateEntrypoint(value.entrypoint, issues);
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
