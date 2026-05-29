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
  SQLITE_CAPABILITY_TERMS,
  SQLITE_DESCRIPTION,
  SQLITE_KIND_SHAPE_ID,
  SQLITE_KIND_VERSION,
  SQLITE_OUTPUT_FIELDS,
  type SqliteCapabilityTerm,
  type SqliteOutputs,
  type SqliteSpec,
} from "./sqlite.generated.ts";

export type { SqliteCapabilityTerm, SqliteOutputs, SqliteSpec };

/**
 * `sqlite@v1` component kind descriptor. An implementation binding
 * materializes the database and publishes its service-binding material.
 *
 * Spec / outputs / capability terms are derived from
 * `packages/kind-sqlite/spec/kind.jsonld` via `sqlite.generated.ts`;
 * validation diagnostics are hand-written below.
 */
export const SqliteKind: Shape<
  SqliteSpec,
  SqliteOutputs,
  SqliteCapabilityTerm
> = {
  id: SQLITE_KIND_SHAPE_ID,
  version: SQLITE_KIND_VERSION,
  description: SQLITE_DESCRIPTION,
  capabilityTerms: SQLITE_CAPABILITY_TERMS,
  outputFields: SQLITE_OUTPUT_FIELDS,
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
      ["databaseId", "name", "url", "tokenSecretRef"],
      issues,
    );
    requireNonEmptyString(value.databaseId, "$.databaseId", issues);
    requireNonEmptyString(value.name, "$.name", issues);
    optionalPasswordlessAbsoluteUri(value.url, "$.url", issues);
    optionalNonEmptyString(value.tokenSecretRef, "$.tokenSecretRef", issues);
  },
};
