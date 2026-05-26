import type {
  Shape,
  ShapeValidationIssue,
} from "takosumi-contract/reference/shape";
import {
  isPositiveInteger,
  isRecord,
  optionalBoolean,
  requireNonEmptyString,
  requirePositiveInteger,
  requireRoot,
} from "./_validators.ts";
import {
  DATABASE_POSTGRES_CAPABILITY_TERMS,
  DATABASE_POSTGRES_DESCRIPTION,
  DATABASE_POSTGRES_KIND_SHAPE_ID,
  DATABASE_POSTGRES_KIND_VERSION,
  DATABASE_POSTGRES_OUTPUT_FIELDS,
  type DatabasePostgresCapabilityTerm,
  type DatabasePostgresOutputs,
  type DatabasePostgresSpec,
  type DatabasePostgresStorage,
} from "./database-postgres.generated.ts";

export type {
  DatabasePostgresCapabilityTerm,
  DatabasePostgresOutputs,
  DatabasePostgresSpec,
  DatabasePostgresStorage,
};

/** Size class union derived from the generated spec interface. */
export type DatabasePostgresSize = DatabasePostgresSpec["size"];

const SIZES: ReadonlySet<string> = new Set(
  [
    "small",
    "medium",
    "large",
    "xlarge",
  ] satisfies DatabasePostgresSize[],
);

/**
 * `postgres@v1` component kind descriptor. Materialized by a provider
 * adapter (managed Postgres or external) at apply time.
 *
 * The TypeScript filename and interface prefix retain `DatabasePostgres` to
 * keep the implementation unambiguous, but the reader-facing kind name is
 * derived from `packages/kind-postgres/spec/kind.jsonld`.
 *
 * Spec / outputs / capability terms are derived from
 * `packages/kind-postgres/spec/kind.jsonld` via
 * `database-postgres.generated.ts`; validation diagnostics are
 * hand-written below.
 */
export const DatabasePostgresKind: Shape<
  DatabasePostgresSpec,
  DatabasePostgresOutputs,
  DatabasePostgresCapabilityTerm
> = {
  id: DATABASE_POSTGRES_KIND_SHAPE_ID,
  version: DATABASE_POSTGRES_KIND_VERSION,
  description: DATABASE_POSTGRES_DESCRIPTION,
  capabilityTerms: DATABASE_POSTGRES_CAPABILITY_TERMS,
  outputFields: DATABASE_POSTGRES_OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.version, "$.version", issues);
    if (typeof value.size !== "string" || !SIZES.has(value.size)) {
      issues.push({
        path: "$.size",
        message: `must be one of: ${Array.from(SIZES).join(", ")}`,
      });
    }
    if (value.storage !== undefined) validateStorage(value.storage, issues);
    optionalBoolean(value.highAvailability, "$.highAvailability", issues);
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.host, "$.host", issues);
    requirePositiveInteger(value.port, "$.port", issues);
    requireNonEmptyString(value.database, "$.database", issues);
    requireNonEmptyString(value.username, "$.username", issues);
    requireNonEmptyString(
      value.passwordSecretRef,
      "$.passwordSecretRef",
      issues,
    );
    requireNonEmptyString(
      value.connectionString,
      "$.connectionString",
      issues,
    );
  },
};

function validateStorage(value: unknown, issues: ShapeValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path: "$.storage", message: "must be an object" });
    return;
  }
  if (!isPositiveInteger(value.sizeGiB)) {
    issues.push({
      path: "$.storage.sizeGiB",
      message: "must be a positive integer",
    });
  }
}
