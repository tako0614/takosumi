import type {
  Shape,
  ShapeValidationIssue,
} from "takosumi-contract/reference/shape";
import {
  optionalNonEmptyString,
  rejectUnknownFields,
  requireNonEmptyString,
  requireRoot,
} from "./_validators.ts";
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
    optionalAbsoluteUriWithoutPassword(value.url, "$.url", issues);
    optionalNonEmptyString(value.tokenSecretRef, "$.tokenSecretRef", issues);
  },
};

function optionalAbsoluteUriWithoutPassword(
  value: unknown,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path, message: "must be an absolute URI" });
    return;
  }
  try {
    const url = new URL(value);
    if (url.password) {
      issues.push({ path, message: "must not contain an embedded password" });
    }
  } catch {
    issues.push({ path, message: "must be an absolute URI" });
  }
}
