import assert from "node:assert/strict";
import type { ShapeValidationIssue } from "takosumi-contract";
import { WebServiceKind } from "../src/kinds/web-service.ts";

function specIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  WebServiceKind.validateSpec(value, issues);
  return issues;
}

function outputIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  WebServiceKind.validateOutputs(value, issues);
  return issues;
}

Deno.test("WebService shape exposes id and version", () => {
  assert.equal(WebServiceKind.id, "web-service");
  assert.equal(WebServiceKind.version, "v1");
});

Deno.test("WebService capabilities include common runtime traits", () => {
  assert.ok(WebServiceKind.capabilities.includes("always-on"));
  assert.ok(WebServiceKind.capabilities.includes("scale-to-zero"));
  assert.ok(WebServiceKind.capabilities.includes("websocket"));
});

Deno.test("WebService outputFields list is fixed", () => {
  assert.deepEqual([...WebServiceKind.outputFields], [
    "url",
    "internalHost",
    "internalPort",
  ]);
});

Deno.test("WebService validateSpec accepts a minimal spec", () => {
  assert.deepEqual(
    specIssues({
      image: "oci://ghcr.io/me/api:latest",
      port: 8080,
      scale: { min: 1, max: 3 },
    }),
    [],
  );
});

Deno.test("WebService validateSpec accepts scale-to-zero minimum", () => {
  assert.deepEqual(
    specIssues({
      image: "oci://ghcr.io/me/api:latest",
      port: 8080,
      scale: { min: 0, max: 3 },
    }),
    [],
  );
});

Deno.test("WebService validateSpec rejects missing image", () => {
  const issues = specIssues({ port: 8080, scale: { min: 1, max: 3 } });
  assert.ok(issues.some((i) => i.path === "$.image"));
});

Deno.test("WebService validateSpec rejects non-positive port", () => {
  const issues = specIssues({
    image: "oci://x",
    port: 0,
    scale: { min: 1, max: 3 },
  });
  assert.ok(issues.some((i) => i.path === "$.port"));
});

Deno.test("WebService validateSpec rejects min > max scale", () => {
  const issues = specIssues({
    image: "oci://x",
    port: 8080,
    scale: { min: 5, max: 3 },
  });
  assert.ok(issues.some((i) => i.path === "$.scale"));
});

Deno.test("WebService validateSpec accepts optional fields", () => {
  assert.deepEqual(
    specIssues({
      image: "oci://x",
      port: 8080,
      scale: { min: 1, max: 3 },
      env: { LOG_LEVEL: "info" },
      bindings: { DB_URL: "${ref:db.connectionString}" },
      resources: { cpu: "256m", memory: "512Mi" },
    }),
    [],
  );
});

Deno.test("WebService validateOutputs accepts a complete outputs", () => {
  assert.deepEqual(
    outputIssues({
      url: "https://api.example.com",
      internalHost: "api.svc.cluster.local",
      internalPort: 8080,
    }),
    [],
  );
});

Deno.test("WebService validateOutputs rejects missing url", () => {
  const issues = outputIssues({
    internalHost: "x",
    internalPort: 8080,
  });
  assert.ok(issues.some((i) => i.path === "$.url"));
});
