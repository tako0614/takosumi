import { expect, test } from "bun:test";
import { checkSpecSchemaForTesting } from "./lint-json-ld.ts";

function messagesFor(spec: unknown): readonly string[] {
  return checkSpecSchemaForTesting(spec).map((issue) => issue.message);
}

test("JSON-LD schema lint requires fixed object schemas to be closed", () => {
  const messages = messagesFor({
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name.",
      },
    },
  });
  expect(messages).toContain(
    "spec.additionalProperties must be false for object schemas with fixed properties",
  );
});

test("JSON-LD schema lint accepts map schemas with propertyNames and value schemas", () => {
  const messages = messagesFor({
    type: "object",
    additionalProperties: false,
    properties: {
      listeners: {
        type: "object",
        description: "Named listeners.",
        propertyNames: {
          type: "string",
          pattern: "^[a-z][a-z0-9-]{0,62}$",
        },
        additionalProperties: {
          type: "object",
          required: ["protocol"],
          additionalProperties: false,
          properties: {
            protocol: {
              type: "string",
              enum: ["http", "https"],
              description: "Protocol.",
            },
          },
        },
      },
    },
  });
  expect(messages).toEqual([]);
});

test("JSON-LD schema lint validates keyword value types", () => {
  const messages = messagesFor({
    type: "object",
    additionalProperties: false,
    properties: {
      name: {
        type: "string",
        description: "Name.",
        pattern: "[",
        minLength: -1,
      },
      count: {
        type: "integer",
        description: "Count.",
        minimum: "1",
      },
      tags: {
        type: "array",
        description: "Tags.",
        minItems: 1.5,
        items: { type: "string" },
      },
    },
  });
  expect(messages).toContain(
    "spec.properties.name.pattern must be a valid regular expression",
  );
  expect(messages).toContain(
    "spec.properties.name.minLength must be a non-negative integer",
  );
  expect(messages).toContain(
    "spec.properties.count.minimum must be a finite number",
  );
  expect(messages).toContain(
    "spec.properties.tags.minItems must be a non-negative integer",
  );
});
