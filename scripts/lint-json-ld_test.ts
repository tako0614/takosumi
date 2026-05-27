import { assert, assertEquals } from "jsr:@std/assert@^1.0.6";
import { checkSpecSchemaForTesting } from "./lint-json-ld.ts";

function messagesFor(spec: unknown): readonly string[] {
  return checkSpecSchemaForTesting(spec).map((issue) => issue.message);
}

Deno.test("JSON-LD schema lint requires fixed object schemas to be closed", () => {
  const messages = messagesFor({
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name.",
      },
    },
  });
  assert(
    messages.includes(
      "spec.additionalProperties must be false for object schemas with fixed properties",
    ),
  );
});

Deno.test("JSON-LD schema lint accepts map schemas with propertyNames and value schemas", () => {
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
  assertEquals(messages, []);
});

Deno.test("JSON-LD schema lint validates keyword value types", () => {
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
  assert(
    messages.includes(
      "spec.properties.name.pattern must be a valid regular expression",
    ),
  );
  assert(
    messages.includes(
      "spec.properties.name.minLength must be a non-negative integer",
    ),
  );
  assert(
    messages.includes("spec.properties.count.minimum must be a finite number"),
  );
  assert(
    messages.includes(
      "spec.properties.tags.minItems must be a non-negative integer",
    ),
  );
});
