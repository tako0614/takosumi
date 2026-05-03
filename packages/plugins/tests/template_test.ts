import assert from "node:assert/strict";
import type {
  ManifestResource,
  TemplateValidationIssue,
} from "takosumi-contract";
import {
  SelfhostedSingleVmTemplate,
  WebAppOnCloudflareTemplate,
} from "../src/templates/mod.ts";

function validateIssues(
  template: { validateInputs(v: unknown, i: TemplateValidationIssue[]): void },
  inputs: unknown,
): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];
  template.validateInputs(inputs, issues);
  return issues;
}

Deno.test("SelfhostedSingleVm template id and version", () => {
  assert.equal(SelfhostedSingleVmTemplate.id, "selfhosted-single-vm");
  assert.equal(SelfhostedSingleVmTemplate.version, "v1");
});

Deno.test("SelfhostedSingleVm validates required inputs", () => {
  assert.deepEqual(
    validateIssues(SelfhostedSingleVmTemplate, {
      serviceName: "api",
      image: "oci://example/api:latest",
      port: 8080,
    }),
    [],
  );
  const missing = validateIssues(SelfhostedSingleVmTemplate, {});
  assert.ok(missing.some((i) => i.path === "$.serviceName"));
  assert.ok(missing.some((i) => i.path === "$.image"));
  assert.ok(missing.some((i) => i.path === "$.port"));
});

Deno.test("SelfhostedSingleVm expands to db + assets + service (no domain)", () => {
  const resources = SelfhostedSingleVmTemplate.expand({
    serviceName: "api",
    image: "oci://example/api:latest",
    port: 8080,
  });
  const names = resources.map((r) => r.name);
  assert.deepEqual(names, ["db", "assets", "api"]);
  const apiResource = resources.find((r) => r.name === "api")!;
  const apiSpec = apiResource.spec as Record<string, unknown>;
  const bindings = apiSpec.bindings as Record<string, string>;
  assert.equal(bindings.DATABASE_URL, "${ref:db.connectionString}");
  assert.equal(bindings.ASSETS_BUCKET, "${ref:assets.bucket}");
});

Deno.test("SelfhostedSingleVm includes custom-domain when domain provided", () => {
  const resources = SelfhostedSingleVmTemplate.expand({
    serviceName: "api",
    image: "oci://example/api:latest",
    port: 8080,
    domain: "api.example.com",
  });
  assert.equal(resources.length, 4);
  const domain = resources.find((r) => r.name === "domain");
  assert.ok(domain);
  assert.equal(domain.shape, "custom-domain@v1");
});

Deno.test("WebAppOnCloudflare template id and version", () => {
  assert.equal(WebAppOnCloudflareTemplate.id, "web-app-on-cloudflare");
  assert.equal(WebAppOnCloudflareTemplate.version, "v1");
});

Deno.test("WebAppOnCloudflare validates required inputs and rejects bad provider", () => {
  assert.deepEqual(
    validateIssues(WebAppOnCloudflareTemplate, {
      serviceName: "api",
      image: "x",
      port: 8080,
      domain: "api.example.com",
    }),
    [],
  );
  const bad = validateIssues(WebAppOnCloudflareTemplate, {
    serviceName: "api",
    image: "x",
    port: 8080,
    domain: "api.example.com",
    databaseProvider: "rdsx",
  });
  assert.ok(bad.some((i) => i.path === "$.databaseProvider"));
});

Deno.test("WebAppOnCloudflare expands to 4 resources with cloudflare bindings", () => {
  const resources: readonly ManifestResource[] = WebAppOnCloudflareTemplate
    .expand({
      serviceName: "api",
      image: "ghcr.io/me/api:latest",
      port: 8080,
      domain: "api.example.com",
    });
  assert.equal(resources.length, 4);
  const apiResource = resources.find((r) => r.name === "api")!;
  assert.equal(apiResource.provider, "@takos/cloudflare-container");
  const assetsResource = resources.find((r) => r.name === "assets")!;
  assert.equal(assetsResource.provider, "@takos/cloudflare-r2");
  const dbResource = resources.find((r) => r.name === "db")!;
  assert.equal(dbResource.provider, "@takos/aws-rds");
  const domainResource = resources.find((r) => r.name === "domain")!;
  assert.equal(domainResource.provider, "@takos/cloudflare-dns");
});
