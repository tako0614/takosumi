import type { Shape } from "takosumi-contract/reference/shape";
import {
  optionalNonEmptyString,
  optionalPasswordlessAbsoluteUri,
  rejectUnknownFields,
  requireEnum,
  requireNonEmptyString,
  requirePositiveInteger,
  requireRoot,
} from "takosumi-contract/reference/shape-validators";
import {
  VECTOR_STORE_CAPABILITY_TERMS,
  VECTOR_STORE_DESCRIPTION,
  VECTOR_STORE_KIND_SHAPE_ID,
  VECTOR_STORE_KIND_VERSION,
  VECTOR_STORE_OUTPUT_FIELDS,
  type VectorStoreCapabilityTerm,
  type VectorStoreOutputs,
  type VectorStoreSpec,
} from "./vector-store.generated.ts";

export type { VectorStoreCapabilityTerm, VectorStoreOutputs, VectorStoreSpec };

const METRIC_VALUES = ["cosine", "euclidean", "dot-product"] as const;

/**
 * `vector-store@v1` component kind descriptor. An implementation binding
 * materializes the index and publishes its service-binding material.
 *
 * Spec / outputs / capability terms are derived from
 * `packages/kind-vector-store/spec/kind.jsonld` via `vector-store.generated.ts`;
 * validation diagnostics are hand-written below.
 */
export const VectorStoreKind: Shape<
  VectorStoreSpec,
  VectorStoreOutputs,
  VectorStoreCapabilityTerm
> = {
  id: VECTOR_STORE_KIND_SHAPE_ID,
  version: VECTOR_STORE_KIND_VERSION,
  description: VECTOR_STORE_DESCRIPTION,
  capabilityTerms: VECTOR_STORE_CAPABILITY_TERMS,
  outputFields: VECTOR_STORE_OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;
    rejectUnknownFields(value, "$", ["name", "dimensions", "metric"], issues);
    requireNonEmptyString(value.name, "$.name", issues);
    requirePositiveInteger(value.dimensions, "$.dimensions", issues);
    requireEnum(value.metric, "$.metric", METRIC_VALUES, issues);
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    rejectUnknownFields(
      value,
      "$",
      ["indexId", "name", "url", "tokenSecretRef"],
      issues,
    );
    requireNonEmptyString(value.indexId, "$.indexId", issues);
    requireNonEmptyString(value.name, "$.name", issues);
    optionalPasswordlessAbsoluteUri(value.url, "$.url", issues);
    optionalNonEmptyString(value.tokenSecretRef, "$.tokenSecretRef", issues);
  },
};
