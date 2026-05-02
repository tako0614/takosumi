import assert from "node:assert/strict";
import type { ShapeValidationIssue } from "takosumi-contract";
import { ObjectStoreShape } from "../src/shapes/object-store.ts";

function specIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  ObjectStoreShape.validateSpec(value, issues);
  return issues;
}

function outputIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  ObjectStoreShape.validateOutputs(value, issues);
  return issues;
}

Deno.test("ObjectStore shape exposes id and version", () => {
  assert.equal(ObjectStoreShape.id, "object-store");
  assert.equal(ObjectStoreShape.version, "v1");
});

Deno.test("ObjectStore output fields cover S3-class portability", () => {
  assert.deepEqual([...ObjectStoreShape.outputFields], [
    "bucket",
    "endpoint",
    "region",
    "accessKeyRef",
    "secretKeyRef",
  ]);
});

Deno.test("ObjectStore validateSpec accepts minimal spec", () => {
  assert.deepEqual(specIssues({ name: "my-bucket" }), []);
});

Deno.test("ObjectStore validateSpec rejects empty name", () => {
  const issues = specIssues({ name: "" });
  assert.ok(issues.some((i) => i.path === "$.name"));
});

Deno.test("ObjectStore validateSpec accepts full spec", () => {
  assert.deepEqual(
    specIssues({
      name: "my-bucket",
      public: true,
      versioning: true,
      region: "us-east-1",
      lifecycle: { expireAfterDays: 30, archiveAfterDays: 90 },
    }),
    [],
  );
});

Deno.test("ObjectStore validateSpec rejects negative lifecycle days", () => {
  const issues = specIssues({
    name: "my-bucket",
    lifecycle: { expireAfterDays: -1 },
  });
  assert.ok(issues.some((i) => i.path === "$.lifecycle.expireAfterDays"));
});

Deno.test("ObjectStore validateOutputs requires all fields", () => {
  const issues = outputIssues({
    bucket: "my-bucket",
    endpoint: "https://s3.amazonaws.com",
    region: "us-east-1",
  });
  assert.ok(issues.some((i) => i.path === "$.accessKeyRef"));
  assert.ok(issues.some((i) => i.path === "$.secretKeyRef"));
});

Deno.test("ObjectStore validateOutputs accepts complete outputs", () => {
  assert.deepEqual(
    outputIssues({
      bucket: "my-bucket",
      endpoint: "https://s3.amazonaws.com",
      region: "us-east-1",
      accessKeyRef: "secret://aws/credentials/access-key",
      secretKeyRef: "secret://aws/credentials/secret-key",
    }),
    [],
  );
});
