import { expect, test } from "bun:test";
import type { TemplateDefinition } from "takosumi-contract/deploy-control-api";
import { generateRootModule } from "./mod.ts";

const R2_TEMPLATE: TemplateDefinition = {
  id: "cloudflare-r2-bucket",
  name: "Cloudflare R2 Bucket",
  version: "1.0.0",
  source: { localModulePath: "/app/templates/cloudflare-r2-bucket/module" },
  inputs: {
    bucketName: { type: "string", title: "Bucket name", required: true },
    accountId: { type: "string", title: "Account id", required: true },
    location: { type: "string", title: "Location", required: false, default: "" },
  },
  outputs: {
    public: {
      bucket_name: { type: "string", from: "bucket_name" },
      location: { type: "string", from: "location" },
    },
  },
  policy: {
    allowedProviders: ["cloudflare/cloudflare"],
    allowedResourceTypes: ["cloudflare_r2_bucket"],
    destructiveChanges: { requireExplicitConfirmation: true },
  },
};

test("rootgen emits versions.tf with required_providers from the policy", () => {
  const { files } = generateRootModule(R2_TEMPLATE, {
    bucketName: "my-bucket",
    accountId: "acct_123",
    location: "",
  });
  expect(files["versions.tf"]).toEqual(
    [
      "terraform {",
      "  required_providers {",
      "    cloudflare = {",
      '      source = "cloudflare/cloudflare"',
      '      version = "~> 5.0"',
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
});

test("rootgen golden main.tf wires the template module with literal inputs", () => {
  const { files } = generateRootModule(R2_TEMPLATE, {
    bucketName: "my-bucket",
    accountId: "acct_123",
    location: "weur",
  });
  expect(files["main.tf"]).toEqual(
    [
      'module "app" {',
      '  source = "./template-module"',
      '  bucketName = "my-bucket"',
      '  accountId = "acct_123"',
      '  location = "weur"',
      "}",
      "",
    ].join("\n"),
  );
});

test("rootgen golden outputs.tf re-exports template public outputs from module.app", () => {
  const { files } = generateRootModule(R2_TEMPLATE, {
    bucketName: "b",
    accountId: "a",
    location: "",
  });
  expect(files["outputs.tf"]).toEqual(
    [
      'output "bucket_name" {',
      "  value = module.app.bucket_name",
      "}",
      "",
      'output "location" {',
      "  value = module.app.location",
      "}",
      "",
    ].join("\n"),
  );
});

test("rootgen omits an optional input that has no value and no default", () => {
  const template: TemplateDefinition = {
    ...R2_TEMPLATE,
    inputs: {
      bucketName: { type: "string", title: "Bucket", required: true },
      note: { type: "string", title: "Note", required: false },
    },
  };
  const { files } = generateRootModule(template, { bucketName: "b" });
  expect(files["main.tf"]).not.toContain("note");
});

test("rootgen renders number and boolean inputs as bare HCL literals", () => {
  const template: TemplateDefinition = {
    ...R2_TEMPLATE,
    inputs: {
      retentionDays: { type: "number", title: "Retention", required: true },
      enabled: { type: "boolean", title: "Enabled", required: true },
    },
  };
  const { files } = generateRootModule(template, {
    retentionDays: 30,
    enabled: true,
  });
  expect(files["main.tf"]).toContain("  retentionDays = 30");
  expect(files["main.tf"]).toContain("  enabled = true");
});

test("rootgen escapes HCL interpolation and quotes in string inputs", () => {
  const { files } = generateRootModule(R2_TEMPLATE, {
    bucketName: 'evil"}"\n${file("/etc/passwd")}',
    accountId: "a",
    location: "%{ for x in y }",
  });
  const main = files["main.tf"]!;
  // The value must stay inside one quoted string: no raw interpolation opener
  // and no premature closing quote+brace can break out of the module block.
  expect(main).toContain('bucketName = "evil\\"}\\"\\n$${file(\\"/etc/passwd\\")}"');
  expect(main).toContain('location = "%%{ for x in y }"');
  // Exactly one module block close brace on its own line.
  expect(main.split("\n").filter((line) => line === "}").length).toEqual(1);
});
