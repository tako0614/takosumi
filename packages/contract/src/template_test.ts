import assert from "node:assert/strict";
import {
  formatTemplateRef,
  getTemplate,
  getTemplateByRef,
  isTemplateRegistered,
  listTemplates,
  parseTemplateRef,
  registerTemplate,
  type Template,
  type TemplateValidationIssue,
  unregisterTemplate,
} from "./template.ts";

function fakeTemplate(id: string, version = "v1"): Template {
  return {
    id,
    version,
    validateInputs(value, issues) {
      if (
        typeof value !== "object" || value === null ||
        typeof (value as { domain?: unknown }).domain !== "string"
      ) {
        issues.push({ path: "$.domain", message: "domain must be string" });
      }
    },
    expand(inputs) {
      const domain = (inputs as { domain?: string }).domain ?? "";
      return [
        {
          shape: "web-service@v1",
          name: "api",
          provider: "@takos/selfhost-docker-compose",
          spec: {
            image: "oci://example/api:latest",
            domain,
          },
        },
      ];
    },
  };
}

Deno.test("parseTemplateRef parses valid id@version", () => {
  assert.deepEqual(parseTemplateRef("selfhosted-single-vm@v1"), {
    id: "selfhosted-single-vm",
    version: "v1",
  });
});

Deno.test("formatTemplateRef round-trips", () => {
  const ref = formatTemplateRef("selfhosted-single-vm", "v1");
  assert.equal(ref, "selfhosted-single-vm@v1");
  assert.deepEqual(parseTemplateRef(ref), {
    id: "selfhosted-single-vm",
    version: "v1",
  });
});

Deno.test("registerTemplate stores and lookups work", () => {
  const tmpl = fakeTemplate("test-template-basic");
  try {
    assert.equal(registerTemplate(tmpl), undefined);
    assert.equal(isTemplateRegistered("test-template-basic", "v1"), true);
    assert.equal(getTemplate("test-template-basic", "v1"), tmpl);
    assert.equal(getTemplateByRef("test-template-basic@v1"), tmpl);
    assert.ok(listTemplates().includes(tmpl));
  } finally {
    unregisterTemplate("test-template-basic", "v1");
  }
});

Deno.test("registerTemplate replaces previous on collision", () => {
  const first = fakeTemplate("test-template-replace");
  const second = fakeTemplate("test-template-replace");
  try {
    registerTemplate(first);
    assert.equal(registerTemplate(second, { allowOverride: true }), first);
    assert.equal(getTemplate("test-template-replace", "v1"), second);
  } finally {
    unregisterTemplate("test-template-replace", "v1");
  }
});

Deno.test("registerTemplate warns on differing-value collision", () => {
  const first = fakeTemplate("test-template-warn");
  const second = fakeTemplate("test-template-warn");
  const captured: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => captured.push(args.join(" "));
  try {
    registerTemplate(first);
    registerTemplate(second); // different reference -> must warn
    assert.equal(captured.length, 1);
    assert.match(captured[0], /template "test-template-warn@v1" overwritten/);
  } finally {
    console.warn = original;
    unregisterTemplate("test-template-warn", "v1");
  }
});

Deno.test("registerTemplate with allowOverride suppresses the warning", () => {
  const first = fakeTemplate("test-template-allow");
  const second = fakeTemplate("test-template-allow");
  const captured: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => captured.push(args.join(" "));
  try {
    registerTemplate(first);
    registerTemplate(second, { allowOverride: true });
    assert.equal(captured.length, 0);
  } finally {
    console.warn = original;
    unregisterTemplate("test-template-allow", "v1");
  }
});

Deno.test("validateInputs accumulates issues", () => {
  const tmpl = fakeTemplate("test-template-validate");
  const issues: TemplateValidationIssue[] = [];
  tmpl.validateInputs({}, issues);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, "$.domain");
});

Deno.test("expand returns ManifestResource[] with inputs threaded", () => {
  const tmpl = fakeTemplate("test-template-expand");
  const resources = tmpl.expand({ domain: "example.com" });
  assert.equal(resources.length, 1);
  assert.equal(resources[0].shape, "web-service@v1");
  assert.equal(resources[0].name, "api");
  assert.equal(
    (resources[0].spec as { domain: string }).domain,
    "example.com",
  );
});
