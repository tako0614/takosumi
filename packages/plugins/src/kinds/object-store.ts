import type { Shape, ShapeValidationIssue } from "takosumi-contract";
import {
  isNonNegativeInteger,
  isRecord,
  optionalBoolean,
  optionalNonEmptyString,
  requireNonEmptyString,
  requireRoot,
} from "./_validators.ts";
import {
  OBJECT_STORE_CAPABILITIES,
  OBJECT_STORE_DESCRIPTION,
  OBJECT_STORE_KIND_ID,
  OBJECT_STORE_KIND_VERSION,
  OBJECT_STORE_OUTPUT_FIELDS,
  type ObjectStoreCapability,
  type ObjectStoreLifecycle,
  type ObjectStoreOutputs,
  type ObjectStoreSpec,
} from "./object-store.generated.ts";

export type {
  ObjectStoreCapability,
  ObjectStoreLifecycle,
  ObjectStoreOutputs,
  ObjectStoreSpec,
};

/**
 * `object-store@v1` component kind descriptor. Materialized by a provider
 * plugin (S3-class API) at apply time.
 *
 * Spec / outputs / capabilities are derived from
 * `spec/contexts/kinds/v1/object-store.jsonld` via
 * `object-store.generated.ts`; validation diagnostics are hand-written
 * below.
 */
export const ObjectStoreKind: Shape<
  ObjectStoreSpec,
  ObjectStoreOutputs,
  ObjectStoreCapability
> = {
  id: OBJECT_STORE_KIND_ID,
  version: OBJECT_STORE_KIND_VERSION,
  description: OBJECT_STORE_DESCRIPTION,
  capabilities: OBJECT_STORE_CAPABILITIES,
  outputFields: OBJECT_STORE_OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.name, "$.name", issues);
    optionalBoolean(value.public, "$.public", issues);
    optionalBoolean(value.versioning, "$.versioning", issues);
    optionalNonEmptyString(value.region, "$.region", issues);
    if (value.lifecycle !== undefined) {
      validateLifecycle(value.lifecycle, issues);
    }
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.bucket, "$.bucket", issues);
    requireNonEmptyString(value.endpoint, "$.endpoint", issues);
    requireNonEmptyString(value.region, "$.region", issues);
    requireNonEmptyString(value.accessKeyRef, "$.accessKeyRef", issues);
    requireNonEmptyString(value.secretKeyRef, "$.secretKeyRef", issues);
  },
};

function validateLifecycle(
  value: unknown,
  issues: ShapeValidationIssue[],
): void {
  if (!isRecord(value)) {
    issues.push({ path: "$.lifecycle", message: "must be an object" });
    return;
  }
  if (
    value.expireAfterDays !== undefined &&
    !isNonNegativeInteger(value.expireAfterDays)
  ) {
    issues.push({
      path: "$.lifecycle.expireAfterDays",
      message: "must be a non-negative integer",
    });
  }
  if (
    value.archiveAfterDays !== undefined &&
    !isNonNegativeInteger(value.archiveAfterDays)
  ) {
    issues.push({
      path: "$.lifecycle.archiveAfterDays",
      message: "must be a non-negative integer",
    });
  }
}
