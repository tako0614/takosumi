import type {
  Shape,
  ShapeValidationIssue,
} from "takosumi-contract/reference/shape";
import {
  isNonEmptyString,
  isRecord,
  optionalNonEmptyString,
  optionalStringRecord,
  rejectUnknownFields,
  requireHttpUrl,
  requireNonEmptyString,
  requireRoot,
} from "takosumi-contract/reference/shape-validators";
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
    rejectUnknownFields(value, "$", ["entrypoint", "env", "schedules"], issues);
    validateEntrypoint(value.entrypoint, issues);
    optionalStringRecord(value.env, "$.env", issues);
    validateSchedules(value.schedules, issues);
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    rejectUnknownFields(value, "$", ["url", "id", "version"], issues);
    requireHttpUrl(value.url, "$.url", issues);
    requireNonEmptyString(value.id, "$.id", issues);
    optionalNonEmptyString(value.version, "$.version", issues);
  },
};

function validateSchedules(
  value: unknown,
  issues: ShapeValidationIssue[],
): void {
  // Optional field: absent is valid.
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({ path: "$.schedules", message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    const path = `$.schedules[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ path, message: "must be an object" });
      return;
    }
    rejectUnknownFields(entry, path, ["cron"], issues);
    // Intentionally only require a non-empty cron string. The cron dialect
    // (Cloudflare cron vs Deno.cron, 5- vs 6-field) is backend-defined and
    // is rejected by the resolving backend at apply, not here.
    if (!isNonEmptyString(entry.cron)) {
      issues.push({
        path: `${path}.cron`,
        message: "must be a non-empty cron expression",
      });
    }
  });
}

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
  const segments = value.split("/");
  if (
    value.startsWith("/") ||
    value.includes("\0") ||
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    issues.push({
      path: "$.entrypoint",
      message:
        "must be a POSIX relative path without NUL, empty, ., or .. segments",
    });
  }
}
