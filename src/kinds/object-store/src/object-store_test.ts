import { assertEquals } from "jsr:@std/assert@^1.0.6";
import type { ShapeValidationIssue } from "takosumi-contract/reference/shape";
import {
  OBJECT_STORE_OUTPUT_FIELDS,
  OBJECT_STORE_OUTPUT_SLOT_DESCRIPTORS,
} from "./object-store.generated.ts";
import { ObjectStoreKind } from "./object-store.ts";

Deno.test("ObjectStoreKind uses official credential output names", () => {
  assertEquals(OBJECT_STORE_OUTPUT_FIELDS, [
    "bucket",
    "endpoint",
    "region",
    "accessKeyIdRef",
    "secretAccessKeyRef",
  ]);
  assertEquals(OBJECT_STORE_OUTPUT_SLOT_DESCRIPTORS[0].exampleMaterialMapping, {
    bucket: "$outputs.bucket",
    endpoint: "$outputs.endpoint",
    region: "$outputs.region",
    accessKeyIdRef: { secretRef: "$outputs.accessKeyIdRef" },
    secretAccessKeyRef: { secretRef: "$outputs.secretAccessKeyRef" },
  });
});

Deno.test("ObjectStoreKind accepts endpoint-only output material", () => {
  assertEquals(
    validateOutputs({
      bucket: "assets",
      endpoint: "https://object-store.example.test",
    }),
    [],
  );
});

Deno.test("ObjectStoreKind keeps portable spec to logical bucket name", () => {
  assertEquals(validateSpec({ name: "assets" }), []);
  assertEquals(
    validateSpec({
      name: "assets",
      public: false,
      versioning: true,
      region: "local",
    }),
    [
      { path: "$.public", message: "unknown field" },
      { path: "$.versioning", message: "unknown field" },
      { path: "$.region", message: "unknown field" },
    ],
  );
});

Deno.test("ObjectStoreKind requires credential refs as a pair", () => {
  assertEquals(
    validateOutputs({
      bucket: "assets",
      endpoint: "https://object-store.example.test",
      accessKeyIdRef: "secret://bucket/access-key-id",
    }),
    [{
      path: "$.secretAccessKeyRef",
      message:
        "object-store credential refs require accessKeyIdRef and secretAccessKeyRef together",
    }],
  );

  assertEquals(
    validateOutputs({
      bucket: "assets",
      endpoint: "https://object-store.example.test",
      secretAccessKeyRef: "secret://bucket/secret-access-key",
    }),
    [{
      path: "$.accessKeyIdRef",
      message:
        "object-store credential refs require accessKeyIdRef and secretAccessKeyRef together",
    }],
  );
});

Deno.test("ObjectStoreKind accepts paired credential refs", () => {
  assertEquals(
    validateOutputs({
      bucket: "assets",
      endpoint: "https://object-store.example.test",
      accessKeyIdRef: "secret://bucket/access-key-id",
      secretAccessKeyRef: "secret://bucket/secret-access-key",
    }),
    [],
  );
});

function validateSpec(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  ObjectStoreKind.validateSpec(value, issues);
  return issues;
}

function validateOutputs(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  ObjectStoreKind.validateOutputs(value, issues);
  return issues;
}
