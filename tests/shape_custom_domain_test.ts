import assert from "node:assert/strict";
import type { ShapeValidationIssue } from "takosumi-contract";
import { CustomDomainShape } from "../src/shapes/custom-domain.ts";

function specIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  CustomDomainShape.validateSpec(value, issues);
  return issues;
}

function outputIssues(value: unknown): ShapeValidationIssue[] {
  const issues: ShapeValidationIssue[] = [];
  CustomDomainShape.validateOutputs(value, issues);
  return issues;
}

Deno.test("CustomDomain shape exposes id and version", () => {
  assert.equal(CustomDomainShape.id, "custom-domain");
  assert.equal(CustomDomainShape.version, "v1");
});

Deno.test("CustomDomain validateSpec accepts minimal spec", () => {
  assert.deepEqual(
    specIssues({
      name: "api.example.com",
      target: "https://internal.example.com",
    }),
    [],
  );
});

Deno.test("CustomDomain validateSpec rejects missing name", () => {
  const issues = specIssues({ target: "https://internal.example.com" });
  assert.ok(issues.some((i) => i.path === "$.name"));
});

Deno.test("CustomDomain validateSpec accepts auto certificate", () => {
  assert.deepEqual(
    specIssues({
      name: "api.example.com",
      target: "https://internal.example.com",
      certificate: { kind: "auto" },
    }),
    [],
  );
});

Deno.test("CustomDomain validateSpec requires secretRef when kind=provided", () => {
  const issues = specIssues({
    name: "api.example.com",
    target: "https://internal.example.com",
    certificate: { kind: "provided" },
  });
  assert.ok(issues.some((i) => i.path === "$.certificate.secretRef"));
});

Deno.test("CustomDomain validateSpec rejects unknown certificate kind", () => {
  const issues = specIssues({
    name: "api.example.com",
    target: "https://internal.example.com",
    certificate: { kind: "byo-only" },
  });
  assert.ok(issues.some((i) => i.path === "$.certificate.kind"));
});

Deno.test("CustomDomain validateSpec accepts redirect entries", () => {
  assert.deepEqual(
    specIssues({
      name: "api.example.com",
      target: "https://internal.example.com",
      redirects: [
        { from: "/old", to: "/new", code: 301 },
      ],
    }),
    [],
  );
});

Deno.test("CustomDomain validateSpec rejects bad redirect code", () => {
  const issues = specIssues({
    name: "api.example.com",
    target: "https://internal.example.com",
    redirects: [{ from: "/old", to: "/new", code: 400 }],
  });
  assert.ok(issues.some((i) => i.path === "$.redirects[0].code"));
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
