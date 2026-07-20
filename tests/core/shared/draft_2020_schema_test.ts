import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  assertDraft202012Schema,
  InterpretedDraft202012Validator,
} from "../../../core/shared/json-schema/draft_2020.ts";

interface ValidationCase {
  readonly name: string;
  readonly schema: unknown;
  readonly valid: readonly unknown[];
  readonly invalid: readonly unknown[];
}

const CASES: readonly ValidationCase[] = [
  {
    name: "type, enum, and const JSON equality",
    schema: {
      anyOf: [
        { const: { pattern: "[", nested: [1, true, null] } },
        { enum: ["other", 42] },
      ],
    },
    valid: [{ pattern: "[", nested: [1, true, null] }, "other", 42],
    invalid: [{ pattern: "]", nested: [1, true, null] }, 41],
  },
  {
    name: "numeric bounds and multipleOf",
    schema: {
      type: "number",
      minimum: 1,
      exclusiveMaximum: 5,
      multipleOf: 0.5,
    },
    valid: [1, 2.5, 4.5],
    invalid: [0.5, 2.3, 5],
  },
  {
    name: "Unicode string length and pattern",
    schema: {
      type: "string",
      minLength: 2,
      maxLength: 3,
      pattern: "^[😀a-z]+$",
    },
    valid: ["😀a", "abc"],
    invalid: ["😀", "abcd", "12"],
  },
  {
    name: "tuple, remaining items, size, and uniqueness",
    schema: {
      type: "array",
      prefixItems: [{ const: "tag" }],
      items: { type: "integer" },
      minItems: 2,
      maxItems: 3,
      uniqueItems: true,
    },
    valid: [
      ["tag", 1],
      ["tag", 1, 2],
    ],
    invalid: [["tag"], ["tag", 1, 1], ["tag", 1.5]],
  },
  {
    name: "contains range",
    schema: {
      type: "array",
      items: true,
      contains: { type: "integer", minimum: 10 },
      minContains: 1,
      maxContains: 2,
    },
    valid: [
      [1, 10],
      [10, 11, "x"],
    ],
    invalid: [
      [1, 2],
      [10, 11, 12],
    ],
  },
  {
    name: "unevaluated array items",
    schema: {
      type: "array",
      prefixItems: [{ type: "string" }],
      unevaluatedItems: false,
    },
    valid: [["first"]],
    invalid: [["first", "second"]],
  },
  {
    name: "closed object properties and cardinality",
    schema: {
      type: "object",
      properties: { name: { type: "string" }, count: { type: "integer" } },
      required: ["name"],
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 2,
    },
    valid: [{ name: "store" }, { name: "store", count: 1 }],
    invalid: [{}, { name: "store", extra: true }, { name: 1 }],
  },
  {
    name: "property and dependency assertions",
    schema: {
      type: "object",
      propertyNames: { pattern: "^[a-z]+$" },
      dependentRequired: { token: ["endpoint"] },
      dependentSchemas: {
        endpoint: {
          properties: { endpoint: { type: "string", minLength: 1 } },
        },
      },
    },
    valid: [{}, { token: "x", endpoint: "https://example.test" }],
    invalid: [{ Bad: true }, { token: "x" }, { endpoint: "" }],
  },
  {
    name: "composition and conditional branches",
    schema: {
      allOf: [{ type: "object" }, { not: { required: ["forbidden"] } }],
      oneOf: [{ required: ["a"] }, { required: ["b"] }],
      if: { required: ["a"] },
      then: { properties: { a: { type: "string" } } },
      else: { properties: { b: { type: "integer" } } },
    },
    valid: [{ a: "x" }, { b: 1 }],
    invalid: [{ a: 1 }, { b: "x" }, { a: "x", b: 1 }, { forbidden: true }],
  },
  {
    name: "local definitions and references",
    schema: {
      $defs: {
        identifier: { type: "string", pattern: "^[a-z][a-z0-9-]+$" },
      },
      $ref: "#/$defs/identifier",
    },
    valid: ["store-1"],
    invalid: ["Store", 1],
  },
  {
    name: "unevaluated properties across a successful applicator",
    schema: {
      type: "object",
      allOf: [
        {
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      ],
      unevaluatedProperties: false,
    },
    valid: [{ name: "store" }],
    invalid: [{ name: "store", extra: true }],
  },
];

test("the eval-free interpreter matches Ajv Draft 2020-12 on the admitted assertion vocabulary", () => {
  for (const entry of CASES) {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: false,
      validateFormats: false,
    });
    const ajvValidate = ajv.compile(structuredClone(entry.schema));
    const interpreted = new InterpretedDraft202012Validator(
      structuredClone(entry.schema),
      entry.name,
    );
    for (const value of entry.valid) {
      expect(interpreted.validate(structuredClone(value)), entry.name).toBe(
        ajvValidate(structuredClone(value)),
      );
      expect(ajvValidate(structuredClone(value)), entry.name).toBe(true);
    }
    for (const value of entry.invalid) {
      expect(interpreted.validate(structuredClone(value)), entry.name).toBe(
        ajvValidate(structuredClone(value)),
      );
      expect(ajvValidate(structuredClone(value)), entry.name).toBe(false);
    }
  }
});

test("Draft 2020-12 schema syntax is checked by the generated meta-schema validator", () => {
  const invalidSchemas: readonly unknown[] = [
    { required: "name" },
    { type: "float" },
    { minimum: "zero" },
    { prefixItems: {} },
    { dependentRequired: { token: ["endpoint", "endpoint"] } },
    { $defs: [] },
  ];
  for (const schema of invalidSchemas) {
    expect(() => assertDraft202012Schema(schema, "test schema")).toThrow(
      "is not a valid Draft 2020-12 schema",
    );
    expect(() => new InterpretedDraft202012Validator(schema)).toThrow(
      "is not a valid Draft 2020-12 schema",
    );
  }
});

test("portable exclusions fail closed before interpretation", () => {
  for (const keyword of [
    "$id",
    "$anchor",
    "$dynamicAnchor",
    "$dynamicRef",
    "$recursiveAnchor",
    "$recursiveRef",
    "$vocabulary",
    "contentEncoding",
    "contentMediaType",
    "contentSchema",
    "dependencies",
    "patternProperties",
  ] as const) {
    const value: unknown =
      keyword === "$dynamicRef" || keyword === "$recursiveRef"
        ? "#node"
        : keyword === "$vocabulary"
          ? { "https://example.test/vocabulary": true }
          : keyword === "contentSchema"
            ? true
            : keyword === "dependencies"
              ? { name: ["value"] }
              : keyword === "patternProperties"
                ? { "^x": true }
                : "test";
    expect(
      () => new InterpretedDraft202012Validator({ [keyword]: value }),
      keyword,
    ).toThrow("is not supported by the portable validator");
  }
});

test("format and extension keywords remain annotations", () => {
  const interpreted = new InterpretedDraft202012Validator({
    type: "string",
    format: "email",
    "x-takoform-note": { pattern: "[" },
  });
  expect(interpreted.validate("not-an-email")).toBe(true);
});
