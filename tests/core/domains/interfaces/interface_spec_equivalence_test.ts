import { expect, test } from "bun:test";
import type { InterfaceSpec } from "takosumi-contract";
import { interfaceSpecsEqual } from "../../../../core/domains/interfaces/interface_spec_equivalence.ts";

const BASE_DOCUMENT = {
  title: "Canonical interface",
  nested: {
    enabled: true,
    label: "example",
  },
};

const BASE_DOCUMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    endpoint: { type: "string" },
    token: { type: "string" },
  },
  required: ["endpoint", "token"],
};

const BASE_INPUTS = {
  endpoint: {
    source: "literal",
    value: "https://example.test/mcp",
  },
  token: {
    source: "resource_output",
    resourceId: "resource_1",
    outputName: "token",
    pointer: "/value",
  },
} satisfies NonNullable<InterfaceSpec["inputs"]>;

const BASE_ACCESS = {
  visibility: "workspace",
  policyRef: "policy.v1",
  resourceUriInput: "endpoint",
} satisfies InterfaceSpec["access"];

const BASE_SPEC: InterfaceSpec = {
  type: "mcp.server",
  version: "1",
  document: BASE_DOCUMENT,
  documentSchema: BASE_DOCUMENT_SCHEMA,
  inputs: BASE_INPUTS,
  access: BASE_ACCESS,
};

test("InterfaceSpec equivalence ignores object insertion order", () => {
  const reordered: InterfaceSpec = {
    access: {
      resourceUriInput: BASE_ACCESS.resourceUriInput,
      policyRef: BASE_ACCESS.policyRef,
      visibility: BASE_ACCESS.visibility,
    },
    inputs: {
      token: BASE_INPUTS.token,
      endpoint: BASE_INPUTS.endpoint,
    },
    documentSchema: {
      required: [...BASE_DOCUMENT_SCHEMA.required],
      properties: {
        token: BASE_DOCUMENT_SCHEMA.properties.token,
        endpoint: BASE_DOCUMENT_SCHEMA.properties.endpoint,
      },
      additionalProperties: BASE_DOCUMENT_SCHEMA.additionalProperties,
      type: BASE_DOCUMENT_SCHEMA.type,
    },
    document: {
      nested: BASE_DOCUMENT.nested,
      title: BASE_DOCUMENT.title,
    },
    version: BASE_SPEC.version,
    type: BASE_SPEC.type,
  };

  expect(interfaceSpecsEqual(BASE_SPEC, reordered)).toBe(true);
});

test("InterfaceSpec equivalence preserves array order", () => {
  const reorderedArray: InterfaceSpec = {
    ...BASE_SPEC,
    documentSchema: {
      ...BASE_DOCUMENT_SCHEMA,
      required: ["token", "endpoint"],
    },
  };

  expect(interfaceSpecsEqual(BASE_SPEC, reorderedArray)).toBe(false);
});

test("InterfaceSpec equivalence detects document, schema, input, and access leaves", () => {
  const changedDocument: InterfaceSpec = {
    ...BASE_SPEC,
    document: { ...BASE_DOCUMENT, title: "Changed interface" },
  };
  const changedDocumentSchema: InterfaceSpec = {
    ...BASE_SPEC,
    documentSchema: { ...BASE_DOCUMENT_SCHEMA, additionalProperties: true },
  };
  const changedInputs: InterfaceSpec = {
    ...BASE_SPEC,
    inputs: {
      ...BASE_INPUTS,
      endpoint: {
        ...BASE_INPUTS.endpoint,
        value: "https://changed.example.test/mcp",
      },
    },
  };
  const changedAccess: InterfaceSpec = {
    ...BASE_SPEC,
    access: { ...BASE_ACCESS, visibility: "private" },
  };

  expect(interfaceSpecsEqual(BASE_SPEC, changedDocument)).toBe(false);
  expect(interfaceSpecsEqual(BASE_SPEC, changedDocumentSchema)).toBe(false);
  expect(interfaceSpecsEqual(BASE_SPEC, changedInputs)).toBe(false);
  expect(interfaceSpecsEqual(BASE_SPEC, changedAccess)).toBe(false);
});
