import { expect, test } from "bun:test";
import Ajv from "ajv/dist/2020.js";
import formDefinitionSchema from "../../../../core/adapters/takoform/schemas/form-definition.schema.json" with { type: "json" };
import provenance from "../../../../core/adapters/takoform/schema-provenance.json" with { type: "json" };
import { canonicalJsonBytes } from "../../../../core/adapters/takoform/canonical_json.ts";
import { sha256HexAsync } from "../../../../core/shared/runtime/hash.ts";

type SchemaProvenance = {
  sourceRepository: string;
  sourceCommit: string;
  sourceCommitScope: string[];
  sourceDirectory: string;
  canonicalDigests: Record<string, string>;
};

const recordedProvenance = provenance as SchemaProvenance;

// A Form Definition that declares a runtime interface is the ordinary case:
// every portable Form Takoform publishes carries one. A vendored schema that
// predates interface declarations therefore rejects real packages outright,
// which is a silent install failure rather than a validation message anyone
// would recognise.
const definitionWithInterface = {
  apiVersion: "forms.takoform.com/v1alpha1",
  kind: "ExampleStore",
  definitionVersion: "1.0.0",
  title: "Example store",
  status: "standard",
  desiredSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: { name: { type: "string", minLength: 1 } },
  },
  observedSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string", minLength: 1 } },
  },
  lifecycleCapabilities: ["create", "read", "delete"],
  interfaces: [
    {
      name: "object.storage",
      version: "1",
      description: "Portable object storage operations.",
      required: true,
      document: { operations: ["get", "put"] },
      documentSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["operations"],
        properties: {
          operations: {
            type: "array",
            minItems: 2,
            maxItems: 2,
            uniqueItems: true,
            items: { type: "string", enum: ["get", "put"] },
          },
        },
      },
      inputs: [
        { name: "resource", source: "output", pointer: "/id" },
        { name: "name", source: "output", pointer: "/name" },
      ],
    },
  ],
};

test("the vendored Form Definition schema accepts a declared runtime interface", () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(formDefinitionSchema as object);
  const accepted = validate(definitionWithInterface);
  expect(validate.errors ?? []).toEqual([]);
  expect(accepted).toBe(true);
});

test("the vendored schemas match the provenance they claim", async () => {
  const schemas: Record<string, unknown> = {
    "form-definition.schema.json": formDefinitionSchema,
    "form-ref.schema.json": await import(
      "../../../../core/adapters/takoform/schemas/form-ref.schema.json",
      { with: { type: "json" } }
    ).then((module) => module.default),
    "package-index.schema.json": await import(
      "../../../../core/adapters/takoform/schemas/package-index.schema.json",
      { with: { type: "json" } }
    ).then((module) => module.default),
    "package-index-v1alpha2.schema.json": await import(
      "../../../../core/adapters/takoform/schemas/package-index-v1alpha2.schema.json",
      { with: { type: "json" } }
    ).then((module) => module.default),
  };
  expect(Object.keys(recordedProvenance.canonicalDigests).sort()).toEqual(
    Object.keys(schemas).sort(),
  );
  for (const [name, digest] of Object.entries(
    recordedProvenance.canonicalDigests,
  )) {
    const bytes = canonicalJsonBytes(schemas[name] as never);
    expect(`sha256:${await sha256HexAsync(bytes)}`).toBe(digest);
  }
});

test("every vendored schema belongs to the exact source commit", () => {
  expect(Object.keys(recordedProvenance).sort()).toEqual(
    [
      "canonicalDigests",
      "sourceCommit",
      "sourceCommitScope",
      "sourceDirectory",
      "sourceRepository",
    ].sort(),
  );
  expect(recordedProvenance.sourceRepository).not.toBe("");
  expect(recordedProvenance.sourceDirectory).not.toBe("");
  expect(recordedProvenance.sourceCommit).toMatch(/^[0-9a-f]{40}$/u);

  expect([...new Set(recordedProvenance.sourceCommitScope)].sort()).toEqual(
    Object.keys(recordedProvenance.canonicalDigests).sort(),
  );
  expect(recordedProvenance.sourceCommitScope).toHaveLength(
    Object.keys(recordedProvenance.canonicalDigests).length,
  );
});
