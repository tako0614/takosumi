import assert from "node:assert/strict";
import type { ShapeValidationIssue } from "takosumi-contract";
import { WebServiceShape } from "../src/shapes/web-service.ts";

function specIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  WebServiceShape.validateSpec(value, issues);
  return issues;
}

function outputIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  WebServiceShape.validateOutputs(value, issues);
  return issues;
}

Deno.test("WebService shape exposes id and version", () => {
  assert.equal(WebServiceShape.id, "web-service");
  assert.equal(WebServiceShape.version, "v1");
});

Deno.test("WebService capabilities include common runtime traits", () => {
  assert.ok(WebServiceShape.capabilities.includes("always-on"));
  assert.ok(WebServiceShape.capabilities.includes("scale-to-zero"));
  assert.ok(WebServiceShape.capabilities.includes("websocket"));
});

Deno.test("WebService outputFields list is fixed", () => {
  assert.deepEqual([...WebServiceShape.outputFields], [
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

Deno.test("WebService validateSpec rejects missing image and artifact", () => {
  const issues = specIssues({ port: 8080, scale: { min: 1, max: 3 } });
  assert.ok(
    issues.some((i) => i.message.includes("$.image or $.artifact must be set")),
  );
});

Deno.test("WebService validateSpec accepts artifact: { kind, uri }", () => {
  assert.deepEqual(
    specIssues({
      artifact: { kind: "oci-image", uri: "ghcr.io/me/api:v1" },
      port: 8080,
      scale: { min: 1, max: 3 },
    }),
    [],
  );
});

Deno.test("WebService validateSpec accepts artifact: { kind, hash }", () => {
  assert.deepEqual(
    specIssues({
      artifact: { kind: "js-bundle", hash: "sha256:abc" },
      port: 8080,
      scale: { min: 1, max: 3 },
    }),
    [],
  );
});

Deno.test("WebService validateSpec rejects artifact missing both uri and hash", () => {
  const issues = specIssues({
    artifact: { kind: "oci-image" },
    port: 8080,
    scale: { min: 1, max: 3 },
  });
  assert.ok(
    issues.some((i) =>
      i.path === "$.artifact" &&
      i.message.includes("$.artifact.uri or $.artifact.hash")
    ),
  );
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
      scale: { min: 1, max: 3, idleSeconds: 60 },
      env: { LOG_LEVEL: "info" },
      bindings: { DB_URL: "${ref:db.connectionString}" },
      health: { path: "/healthz", intervalSeconds: 10 },
      resources: { cpu: "256m", memory: "512Mi" },
      command: ["node", "server.js"],
      domains: ["api.example.com"],
    }),
    [],
  );
});

Deno.test("WebService validateSpec rejects non-absolute health path", () => {
  const issues = specIssues({
    image: "oci://x",
    port: 8080,
    scale: { min: 1, max: 3 },
    health: { path: "healthz" },
  });
  assert.ok(issues.some((i) => i.path === "$.health.path"));
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
