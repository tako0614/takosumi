import assert from "node:assert/strict";
import type { ShapeValidationIssue } from "takosumi-contract";
import { CustomDomainKind } from "../src/kinds/custom-domain.ts";

function specIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  CustomDomainKind.validateSpec(value, issues);
  return issues;
}

function outputIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  CustomDomainKind.validateOutputs(value, issues);
  return issues;
}

Deno.test("CustomDomain shape exposes id and version", () => {
  assert.equal(CustomDomainKind.id, "custom-domain");
  assert.equal(CustomDomainKind.version, "v1");
});

Deno.test("CustomDomain validateSpec accepts minimal spec", () => {
  assert.deepEqual(
    specIssues({
      name: "api.example.com",
    }),
    [],
  );
});

Deno.test("CustomDomain validateSpec rejects missing name", () => {
  const issues = specIssues({});
  assert.ok(issues.some((i) => i.path === "$.name"));
});

Deno.test("CustomDomain validateOutputs accepts minimal outputs", () => {
  assert.deepEqual(outputIssues({ fqdn: "api.example.com" }), []);
});

Deno.test("CustomDomain validateOutputs rejects missing fqdn", () => {
  const issues = outputIssues({});
  assert.ok(issues.some((i) => i.path === "$.fqdn"));
});

Deno.test("CustomDomain validateOutputs accepts nameservers list", () => {
  assert.deepEqual(
    outputIssues({
      fqdn: "api.example.com",
      nameservers: ["ns1.example.com", "ns2.example.com"],
    }),
    [],
  );
});
