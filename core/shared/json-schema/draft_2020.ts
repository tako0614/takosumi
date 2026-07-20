import {
  Validator,
  type Schema,
  type ValidationResult,
} from "@cfworker/json-schema";
import { validateDraft202012Schema } from "./draft_2020_schema.generated.ts";

interface StaticSchemaValidationError {
  readonly instancePath?: string;
  readonly keyword?: string;
  readonly message?: string;
}

interface StaticSchemaValidator {
  (value: unknown): boolean;
  readonly errors?: readonly StaticSchemaValidationError[] | null;
}

export function assertDraft202012Schema(schema: unknown, label: string): void {
  const validate = validateDraft202012Schema as StaticSchemaValidator;
  if (validate(schema)) return;
  throw new TypeError(
    `${label} is not a valid Draft 2020-12 schema${formatStaticErrors(validate.errors)}`,
  );
}

/**
 * Eval-free instance validator for the Takosumi-admitted portable schema
 * subset. A generated Draft 2020-12 meta-schema validator first proves schema
 * syntax; the interpreter then evaluates instance assertions without codegen.
 *
 * `format` remains an annotation, matching the previous Ajv
 * `validateFormats: false` contract. Unknown keywords are annotations too and
 * are omitted from the interpreter view. Every validation keyword admitted by
 * the portable verifier is retained.
 */
export class InterpretedDraft202012Validator {
  readonly #validator: Validator;
  #result: ValidationResult | undefined;

  constructor(schema: unknown, label = "schema") {
    assertDraft202012Schema(schema, label);
    this.#validator = new Validator(
      portableValidationView(schema) as Schema | boolean,
      "2020-12",
      false,
    );
  }

  validate(value: unknown): boolean {
    this.#result = this.#validator.validate(value);
    return this.#result.valid;
  }

  errorsText(): string {
    return (this.#result?.errors ?? [])
      .map(
        (error) =>
          `${error.instanceLocation || "#"} ${error.keyword}: ${error.error}`,
      )
      .join("; ");
  }
}

function portableValidationView(value: unknown): unknown {
  if (value === true || value === false) return value;
  if (!isRecord(value)) {
    throw new TypeError("schema node must be an object or boolean");
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PORTABLE_SCHEMA_KEYWORDS.has(key)) {
      throw new TypeError(`${key} is not supported by the portable validator`);
    }
    if (SINGLE_SCHEMA_KEYWORDS.has(key)) {
      result[key] = portableValidationView(child);
      continue;
    }
    if (ARRAY_SCHEMA_KEYWORDS.has(key)) {
      if (!Array.isArray(child)) {
        throw new TypeError(`${key} must be a schema array`);
      }
      result[key] = child.map(portableValidationView);
      continue;
    }
    if (MAP_SCHEMA_KEYWORDS.has(key)) {
      if (!isRecord(child)) {
        throw new TypeError(`${key} must be a schema map`);
      }
      result[key] = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [
          name,
          portableValidationView(schema),
        ]),
      );
      continue;
    }
    if (INSTANCE_VALIDATION_KEYWORDS.has(key)) {
      result[key] = structuredClone(child);
    }
    // `$schema`, `format`, standard annotations, and unknown extension
    // annotations intentionally have no assertion effect.
  }
  return result;
}

const SINGLE_SCHEMA_KEYWORDS = new Set([
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

const ARRAY_SCHEMA_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);

const MAP_SCHEMA_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "properties",
]);

const INSTANCE_VALIDATION_KEYWORDS = new Set([
  "$ref",
  "const",
  "dependentRequired",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "pattern",
  "required",
  "type",
  "uniqueItems",
]);

const FORBIDDEN_PORTABLE_SCHEMA_KEYWORDS = new Set([
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$id",
  "$recursiveAnchor",
  "$recursiveRef",
  "$vocabulary",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "dependencies",
  "patternProperties",
]);

function formatStaticErrors(
  errors: readonly StaticSchemaValidationError[] | null | undefined,
): string {
  if (!errors?.length) return "";
  return `: ${errors
    .map(
      (error) =>
        `${error.instancePath || "/"} ${error.message ?? error.keyword ?? "is invalid"}`,
    )
    .join("; ")}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
