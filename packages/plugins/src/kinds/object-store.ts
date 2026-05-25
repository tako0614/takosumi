import type { Shape } from "takosumi-contract/reference/shape";
import {
  optionalBoolean,
  optionalNonEmptyString,
  requireNonEmptyString,
  requireRoot,
} from "./_validators.ts";
import {
  OBJECT_STORE_CAPABILITY_TERMS,
  OBJECT_STORE_DESCRIPTION,
  OBJECT_STORE_KIND_SHAPE_ID,
  OBJECT_STORE_KIND_VERSION,
  OBJECT_STORE_OUTPUT_FIELDS,
  type ObjectStoreCapabilityTerm,
  type ObjectStoreOutputs,
  type ObjectStoreSpec,
} from "./object-store.generated.ts";

export type { ObjectStoreCapabilityTerm, ObjectStoreOutputs, ObjectStoreSpec };

/**
 * `object-store@v1` component kind descriptor. Materialized by a provider
 * adapter (S3-class API) at apply time.
 *
 * Spec / outputs / capability terms are derived from
 * `packages/plugins/spec/kinds/v1/object-store.jsonld` via
 * `object-store.generated.ts`; validation diagnostics are hand-written
 * below.
 */
export const ObjectStoreKind: Shape<
  ObjectStoreSpec,
  ObjectStoreOutputs,
  ObjectStoreCapabilityTerm
> = {
  id: OBJECT_STORE_KIND_SHAPE_ID,
  version: OBJECT_STORE_KIND_VERSION,
  description: OBJECT_STORE_DESCRIPTION,
  capabilityTerms: OBJECT_STORE_CAPABILITY_TERMS,
  outputFields: OBJECT_STORE_OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.name, "$.name", issues);
    optionalBoolean(value.public, "$.public", issues);
    optionalBoolean(value.versioning, "$.versioning", issues);
    optionalNonEmptyString(value.region, "$.region", issues);
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
