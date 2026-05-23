import assert from "node:assert/strict";
import type { ShapeValidationIssue } from "takosumi-contract";
import { WorkerKind } from "../src/kinds/worker.ts";

function specIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  WorkerKind.validateSpec(value, issues);
  return issues;
}

function outputIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  WorkerKind.validateOutputs(value, issues);
  return issues;
}

const validSpec = () => ({
  entrypoint: "dist/worker.mjs",
});

Deno.test("Worker shape exposes id and version", () => {
  assert.equal(WorkerKind.id, "worker");
  assert.equal(WorkerKind.version, "v1");
});

Deno.test("Worker capabilities cover serverless traits", () => {
  assert.ok(WorkerKind.capabilities.includes("scale-to-zero"));
  assert.ok(WorkerKind.capabilities.includes("long-request"));
  assert.ok(WorkerKind.capabilities.includes("geo-routing"));
});

Deno.test("Worker outputFields list is fixed", () => {
  assert.deepEqual([...WorkerKind.outputFields], [
    "url",
    "id",
    "version",
  ]);
});

Deno.test("Worker validateSpec accepts a source-root-relative entrypoint", () => {
  assert.deepEqual(
    specIssues({
      entrypoint: "dist/worker.mjs",
    }),
    [],
  );
});

Deno.test("Worker validateSpec rejects absolute entrypoint paths", () => {
  const issues = specIssues({
    entrypoint: "/dist/worker.mjs",
  });
  assert.ok(
    issues.some((i) =>
      i.path === "$.entrypoint" && i.message.includes("source root")
    ),
  );
});

Deno.test("Worker validateSpec accepts optional fields", () => {
  assert.deepEqual(
    specIssues({
      ...validSpec(),
      compatibilityFlags: ["nodejs_compat"],
      env: { LOG_LEVEL: "info" },
    }),
    [],
  );
});

Deno.test("Worker validateSpec rejects missing entrypoint", () => {
  const issues = specIssues({});
  assert.ok(issues.some((i) => i.path === "$.entrypoint"));
});

Deno.test("Worker validateSpec rejects escaping entrypoint paths", () => {
  const issues = specIssues({
    entrypoint: "../worker.mjs",
  });
  assert.ok(issues.some((i) => i.path === "$.entrypoint"));
});

Deno.test("Worker validateSpec rejects empty compatibilityDate when present", () => {
  const issues = specIssues({
    entrypoint: "dist/worker.mjs",
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

// `Worker validateSpec rejects non-array routes` removed: routes were
// dropped from worker.jsonld (Wave J Component contract minimization);
// the kind validator no longer constrains routes since materializers
// decide whether to read `spec.routes` as an implementation convention.

Deno.test("Worker validateOutputs accepts complete outputs", () => {
  assert.deepEqual(
    outputIssues({
      url: "https://api.script.acct.workers.dev",
      id: "api",
      version: "v1",
    }),
    [],
  );
});

Deno.test("Worker validateOutputs accepts outputs without version", () => {
  assert.deepEqual(
    outputIssues({
      url: "https://api.script.acct.workers.dev",
      id: "api",
    }),
    [],
  );
});

Deno.test("Worker validateOutputs rejects missing url", () => {
  const issues = outputIssues({ id: "api" });
  assert.ok(issues.some((i) => i.path === "$.url"));
});

Deno.test("Worker validateOutputs rejects missing id", () => {
  const issues = outputIssues({ url: "https://x" });
  assert.ok(issues.some((i) => i.path === "$.id"));
});

Deno.test("Worker validateOutputs rejects empty version when present", () => {
  const issues = outputIssues({
    url: "https://x",
    id: "api",
    version: "",
  });
  assert.ok(issues.some((i) => i.path === "$.version"));
});
