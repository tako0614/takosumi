import assert from "node:assert/strict";
import type { ShapeValidationIssue } from "takosumi-contract/reference/compat";
import { GatewayKind } from "../src/kinds/gateway.ts";

function specIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  GatewayKind.validateSpec(value, issues);
  return issues;
}

function outputIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  GatewayKind.validateOutputs(value, issues);
  return issues;
}

Deno.test("Gateway shape exposes id and version", () => {
  assert.equal(GatewayKind.id, "gateway");
  assert.equal(GatewayKind.version, "v1");
});

Deno.test("Gateway validateSpec accepts listener and route", () => {
  assert.deepEqual(
    specIssues({
      listeners: {
        public: { protocol: "https", host: "api.example.com", tls: "auto" },
      },
      routes: [{ listener: "public", path: "/", to: "upstream" }],
    }),
    [],
  );
});

Deno.test("Gateway validateSpec rejects missing listeners", () => {
  const issues = specIssues({
    routes: [{ listener: "public", path: "/", to: "upstream" }],
  });
  assert.ok(issues.some((i) => i.path === "$.listeners"));
});

Deno.test("Gateway validateSpec rejects invalid route path", () => {
  const issues = specIssues({
    listeners: { public: { protocol: "https" } },
    routes: [{ listener: "public", path: "api", to: "upstream" }],
  });
  assert.ok(issues.some((i) => i.path === "$.routes[0].path"));
});

Deno.test("Gateway validateSpec enforces route syntax from descriptor", () => {
  const issues = specIssues({
    listeners: { public: { protocol: "https" } },
    routes: [{ listener: "Public", path: "/api?x=1", to: "upstream_api" }],
  });
  assert.ok(issues.some((i) => i.path === "$.routes[0].listener"));
  assert.ok(issues.some((i) => i.path === "$.routes[0].path"));
  assert.ok(issues.some((i) => i.path === "$.routes[0].to"));
});

Deno.test("Gateway validateOutputs accepts public endpoint output", () => {
  assert.deepEqual(
    outputIssues({
      url: "https://api.example.com",
      host: "api.example.com",
      scheme: "https",
      listener: "public",
      routes: [{ pathPrefix: "/", to: "upstream" }],
    }),
    [],
  );
});

Deno.test("Gateway validateOutputs rejects missing url", () => {
  const issues = outputIssues({
    host: "api.example.com",
    scheme: "https",
    listener: "public",
    routes: [{ pathPrefix: "/", to: "upstream" }],
  });
  assert.ok(issues.some((i) => i.path === "$.url"));
});
