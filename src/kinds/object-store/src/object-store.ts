import type { Shape } from "takosumi-contract/reference/shape";
import {
  optionalNonEmptyString,
  rejectUnknownFields,
  requireHttpUrl,
  requireNonEmptyString,
  requireRoot,
} from "takosumi-contract/reference/shape-validators";
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
 * `packages/kind-object-store/spec/kind.jsonld` via
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
    rejectUnknownFields(value, "$", ["name"], issues);
    requireNonEmptyString(value.name, "$.name", issues);
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    rejectUnknownFields(
      value,
      "$",
      [
        "bucket",
        "endpoint",
        "region",
        "accessKeyIdRef",
        "secretAccessKeyRef",
      ],
      issues,
    );
    requireNonEmptyString(value.bucket, "$.bucket", issues);
    requireHttpUrl(value.endpoint, "$.endpoint", issues);
    optionalNonEmptyString(value.region, "$.region", issues);
    optionalNonEmptyString(value.accessKeyIdRef, "$.accessKeyIdRef", issues);
    optionalNonEmptyString(
      value.secretAccessKeyRef,
      "$.secretAccessKeyRef",
      issues,
    );

    const hasAccessKeyId = typeof value.accessKeyIdRef === "string";
    const hasSecretAccessKey = typeof value.secretAccessKeyRef === "string";
    if (hasAccessKeyId !== hasSecretAccessKey) {
      issues.push({
        path: hasAccessKeyId ? "$.secretAccessKeyRef" : "$.accessKeyIdRef",
        message:
          "object-store credential refs require accessKeyIdRef and secretAccessKeyRef together",
      });
    }
  },
};
