import type {
  Shape,
  ShapeValidationIssue,
} from "takosumi-contract/reference/shape";
import {
  optionalNonEmptyString,
  optionalPasswordlessAbsoluteUri,
  rejectUnknownFields,
  requireNonEmptyString,
  requireRoot,
} from "takosumi-contract/reference/shape-validators";
import {
  KV_STORE_CAPABILITY_TERMS,
  KV_STORE_DESCRIPTION,
  KV_STORE_KIND_SHAPE_ID,
  KV_STORE_KIND_VERSION,
  KV_STORE_OUTPUT_FIELDS,
  type KvStoreCapabilityTerm,
  type KvStoreOutputs,
  type KvStoreSpec,
} from "./kv-store.generated.ts";

export type { KvStoreCapabilityTerm, KvStoreOutputs, KvStoreSpec };

/**
 * `kv-store@v1` component kind descriptor. An implementation binding
 * materializes the store and publishes its service-binding material.
 *
 * Spec / outputs / capability terms are derived from
 * `packages/kind-kv-store/spec/kind.jsonld` via `kv-store.generated.ts`;
 * validation diagnostics are hand-written below.
 */
export const KvStoreKind: Shape<
  KvStoreSpec,
  KvStoreOutputs,
  KvStoreCapabilityTerm
> = {
  id: KV_STORE_KIND_SHAPE_ID,
  version: KV_STORE_KIND_VERSION,
  description: KV_STORE_DESCRIPTION,
  capabilityTerms: KV_STORE_CAPABILITY_TERMS,
  outputFields: KV_STORE_OUTPUT_FIELDS,
  validateSpec(value: unknown, issues: ShapeValidationIssue[]) {
    if (!requireRoot(value, issues)) return;
    rejectUnknownFields(value, "$", ["name"], issues);
    requireNonEmptyString(value.name, "$.name", issues);
  },
  validateOutputs(value: unknown, issues: ShapeValidationIssue[]) {
    if (!requireRoot(value, issues)) return;
    rejectUnknownFields(
      value,
      "$",
      ["storeId", "name", "url", "tokenSecretRef"],
      issues,
    );
    requireNonEmptyString(value.storeId, "$.storeId", issues);
    requireNonEmptyString(value.name, "$.name", issues);
    optionalPasswordlessAbsoluteUri(value.url, "$.url", issues);
    optionalNonEmptyString(value.tokenSecretRef, "$.tokenSecretRef", issues);
  },
};
