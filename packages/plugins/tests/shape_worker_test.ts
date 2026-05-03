import assert from "node:assert/strict";
import type { ShapeValidationIssue } from "takosumi-contract";
import { WorkerShape } from "../src/shapes/worker.ts";

function specIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  WorkerShape.validateSpec(value, issues);
  return issues;
}

function outputIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  WorkerShape.validateOutputs(value, issues);
  return issues;
}

const validSpec = () => ({
  artifact: { kind: "js-bundle", hash: "sha256:abc" },
  compatibilityDate: "2025-01-01",
});

Deno.test("Worker shape exposes id and version", () => {
  assert.equal(WorkerShape.id, "worker");
  assert.equal(WorkerShape.version, "v1");
});

Deno.test("Worker capabilities cover serverless traits", () => {
  assert.ok(WorkerShape.capabilities.includes("scale-to-zero"));
  assert.ok(WorkerShape.capabilities.includes("websocket"));
  assert.ok(WorkerShape.capabilities.includes("crons"));
});

Deno.test("Worker outputFields list is fixed", () => {
  assert.deepEqual([...WorkerShape.outputFields], [
    "url",
    "scriptName",
    "version",
  ]);
});

Deno.test("Worker validateSpec accepts a minimal spec", () => {
  assert.deepEqual(specIssues(validSpec()), []);
});

Deno.test("Worker validateSpec accepts optional fields", () => {
  assert.deepEqual(
    specIssues({
      ...validSpec(),
      compatibilityFlags: ["nodejs_compat"],
      env: { LOG_LEVEL: "info" },
      routes: ["api.example.com/*"],
    }),
    [],
  );
});

Deno.test("Worker validateSpec rejects missing artifact", () => {
  const issues = specIssues({ compatibilityDate: "2025-01-01" });
  assert.ok(issues.some((i) => i.path === "$.artifact"));
});

Deno.test("Worker validateSpec rejects non-js-bundle artifact kind", () => {
  const issues = specIssues({
    artifact: { kind: "oci-image", hash: "sha256:abc" },
    compatibilityDate: "2025-01-01",
  });
  assert.ok(
    issues.some((i) =>
      i.path === "$.artifact.kind" && i.message.includes("js-bundle")
    ),
  );
});

Deno.test("Worker validateSpec rejects empty artifact.kind", () => {
  const issues = specIssues({
    artifact: { kind: "", hash: "sha256:abc" },
    compatibilityDate: "2025-01-01",
  });
  assert.ok(issues.some((i) => i.path === "$.artifact.kind"));
});

Deno.test("Worker validateSpec rejects missing artifact.hash", () => {
  const issues = specIssues({
    artifact: { kind: "js-bundle" },
    compatibilityDate: "2025-01-01",
  });
  assert.ok(issues.some((i) => i.path === "$.artifact.hash"));
});

Deno.test("Worker validateSpec rejects empty compatibilityDate", () => {
  const issues = specIssues({
    artifact: { kind: "js-bundle", hash: "sha256:abc" },
    compatibilityDate: "",
  });
  assert.ok(issues.some((i) => i.path === "$.compatibilityDate"));
});

Deno.test("Worker validateSpec rejects non-array compatibilityFlags", () => {
  const issues = specIssues({
    ...validSpec(),
    compatibilityFlags: "nodejs_compat",
  });
  assert.ok(issues.some((i) => i.path === "$.compatibilityFlags"));
});

Deno.test("Worker validateSpec rejects non-string compatibilityFlags entry", () => {
  const issues = specIssues({
    ...validSpec(),
    compatibilityFlags: ["ok", 5],
  });
  assert.ok(issues.some((i) => i.path === "$.compatibilityFlags"));
});

Deno.test("Worker validateSpec rejects non-string env value", () => {
  const issues = specIssues({
    ...validSpec(),
    env: { N: 5 },
  });
  assert.ok(issues.some((i) => i.path === "$.env"));
});

Deno.test("Worker validateSpec rejects non-array routes", () => {
  const issues = specIssues({
    ...validSpec(),
    routes: "api.example.com/*",
  });
  assert.ok(issues.some((i) => i.path === "$.routes"));
});

Deno.test("Worker validateOutputs accepts complete outputs", () => {
  assert.deepEqual(
    outputIssues({
      url: "https://api.script.acct.workers.dev",
      scriptName: "api",
      version: "v1",
    }),
    [],
  );
});

Deno.test("Worker validateOutputs accepts outputs without version", () => {
  assert.deepEqual(
    outputIssues({
      url: "https://api.script.acct.workers.dev",
      scriptName: "api",
    }),
    [],
  );
});

Deno.test("Worker validateOutputs rejects missing url", () => {
  const issues = outputIssues({ scriptName: "api" });
  assert.ok(issues.some((i) => i.path === "$.url"));
});

Deno.test("Worker validateOutputs rejects missing scriptName", () => {
  const issues = outputIssues({ url: "https://x" });
  assert.ok(issues.some((i) => i.path === "$.scriptName"));
});

Deno.test("Worker validateOutputs rejects empty version when present", () => {
  const issues = outputIssues({
    url: "https://x",
    scriptName: "api",
    version: "",
  });
  assert.ok(issues.some((i) => i.path === "$.version"));
});
