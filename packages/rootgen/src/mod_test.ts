import { expect, test } from "bun:test";
import type { TemplateDefinition } from "@takosumi/internal/deploy-control-api";
import {
  generateGenericCapsuleRoot,
  generateInstallationRoot,
  generateRootModule,
} from "./mod.ts";

const R2_TEMPLATE: TemplateDefinition = {
  id: "cloudflare-r2-storage",
  name: "Cloudflare R2 Storage",
  version: "1.0.0",
  source: { localModulePath: "/app/templates/cloudflare-r2-storage/module" },
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

test("rootgen golden main.tf wires the child module with literal inputs", () => {
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

// ---------------------------------------------------------------------------
// generateInstallationRoot (§13 installType-aware root)
// ---------------------------------------------------------------------------

test("generateInstallationRoot provider-free root is byte-stable vs generateRootModule", () => {
  const inputs = { bucketName: "my-bucket", accountId: "acct_123", location: "weur" };
  const legacy = generateRootModule(R2_TEMPLATE, inputs);
  for (const installType of ["core", "opentofu_module"] as const) {
    const next = generateInstallationRoot({
      template: R2_TEMPLATE,
      inputs,
      installType,
    });
    expect(next.files).toEqual(legacy.files);
  }
});

test("generateInstallationRoot core and opentofu_module are structurally identical", () => {
  const inputs = { bucketName: "b", accountId: "a", location: "" };
  const core = generateInstallationRoot({
    template: R2_TEMPLATE,
    inputs,
    installType: "core",
  });
  const mod = generateInstallationRoot({
    template: R2_TEMPLATE,
    inputs,
    installType: "opentofu_module",
  });
  expect(core.files).toEqual(mod.files);
});

test("generateInstallationRoot golden provider-aliased main.tf", () => {
  const { files } = generateInstallationRoot({
    template: R2_TEMPLATE,
    inputs: { bucketName: "my-bucket", accountId: "acct_123", location: "weur" },
    installType: "opentofu_module",
    providerBindings: [
      { provider: "cloudflare/cloudflare", alias: "main" },
      { provider: "cloudflare", alias: "zone" },
      { provider: "hashicorp/aws", alias: "archive" },
    ],
  });
  expect(files["main.tf"]).toEqual(
    [
      "# Generated by Takosumi rootgen.",
      "# Provider credentials are root-only: the generated root wires provider",
      "# blocks from sensitive variables minted by the Vault. Child modules",
      "# receive only provider configurations.",
      "",
      'variable "cloudflare_main_api_token" {',
      "  type      = string",
      "  sensitive = true",
      "  ephemeral = true",
      "}",
      "",
      'variable "cloudflare_zone_api_token" {',
      "  type      = string",
      "  sensitive = true",
      "  ephemeral = true",
      "}",
      "",
      'variable "aws_archive_access_key" {',
      "  type      = string",
      "  sensitive = true",
      "  ephemeral = true",
      "}",
      "",
      'variable "aws_archive_secret_key" {',
      "  type      = string",
      "  sensitive = true",
      "  ephemeral = true",
      "}",
      "",
      'variable "aws_archive_token" {',
      "  type      = string",
      "  sensitive = true",
      "  ephemeral = true",
      "}",
      "",
      'provider "cloudflare" {',
      '  alias = "main"',
      "  api_token = var.cloudflare_main_api_token",
      "}",
      "",
      'provider "cloudflare" {',
      '  alias = "zone"',
      "  api_token = var.cloudflare_zone_api_token",
      "}",
      "",
      'provider "aws" {',
      '  alias = "archive"',
      "  access_key = var.aws_archive_access_key",
      "  secret_key = var.aws_archive_secret_key",
      "  token = var.aws_archive_token",
      "}",
      "",
      'module "app" {',
      '  source = "./template-module"',
      "",
      "  providers = {",
      "    cloudflare.main = cloudflare.main",
      "    cloudflare.zone = cloudflare.zone",
      "    aws.archive = aws.archive",
      "  }",
      "",
      '  bucketName = "my-bucket"',
      '  accountId = "acct_123"',
      '  location = "weur"',
      "}",
      "",
    ].join("\n"),
  );
  // versions.tf / outputs.tf are unchanged by provider aliasing.
  expect(files["versions.tf"]).toEqual(
    generateRootModule(R2_TEMPLATE, { bucketName: "b", accountId: "a", location: "" })
      .files["versions.tf"],
  );
});

test("generateInstallationRoot app_source threads a generated artifact_path variable", () => {
  const APP_TEMPLATE: TemplateDefinition = {
    ...R2_TEMPLATE,
    id: "cloudflare-worker-deploy",
    inputs: {
      service_slug: { type: "string", title: "Service slug", required: true },
      artifact_path: { type: "string", title: "Artifact path", required: true },
    },
  };
  const { files } = generateInstallationRoot({
    template: APP_TEMPLATE,
    inputs: { service_slug: "talk" },
    installType: "app_source",
  });
  expect(files["main.tf"]).toEqual(
    [
      'variable "artifact_path" {',
      '  default = "/work/artifact"',
      "}",
      "",
      'module "app" {',
      '  source = "./template-module"',
      "  service_slug = \"talk\"",
      "  artifact_path = var.artifact_path",
      "}",
      "",
    ].join("\n"),
  );
});

test("generateInstallationRoot app_source without an artifact_path input emits no variable", () => {
  const { files } = generateInstallationRoot({
    template: R2_TEMPLATE,
    inputs: { bucketName: "b", accountId: "a", location: "" },
    installType: "app_source",
  });
  expect(files["main.tf"]).not.toContain("variable");
  expect(files["main.tf"]).not.toContain("artifact_path");
});

test("generateInstallationRoot app_source can combine artifact variable with provider aliases", () => {
  const APP_TEMPLATE: TemplateDefinition = {
    ...R2_TEMPLATE,
    inputs: {
      artifact_path: { type: "string", title: "Artifact path", required: true },
    },
  };
  const { files } = generateInstallationRoot({
    template: APP_TEMPLATE,
    inputs: {},
    installType: "app_source",
    providerBindings: [{ provider: "cloudflare", alias: "main" }],
  });
  const main = files["main.tf"]!;
  expect(main).toContain('provider "cloudflare" {');
  expect(main).toContain('variable "artifact_path" {');
  expect(main).toContain("    cloudflare.main = cloudflare.main");
  expect(main).toContain("  artifact_path = var.artifact_path");
  // The per-alias credential split is wired alongside the artifact variable.
  expect(main).toContain('variable "cloudflare_main_api_token" {');
  expect(main).toContain("  api_token = var.cloudflare_main_api_token");
});

test("generateInstallationRoot wires a sensitive per-alias credential var into the cloudflare alias (§13)", () => {
  const { files } = generateInstallationRoot({
    template: R2_TEMPLATE,
    inputs: { bucketName: "b", accountId: "a", location: "" },
    installType: "opentofu_module",
    providerBindings: [{ provider: "cloudflare", alias: "main" }],
  });
  const main = files["main.tf"]!;
  // A sensitive credential variable is declared and the alias reads it.
  expect(main).toContain('variable "cloudflare_main_api_token" {');
  expect(main).toContain("  sensitive = true");
  expect(main).toContain("  ephemeral = true");
  expect(main).toContain('provider "cloudflare" {');
  expect(main).toContain('  alias = "main"');
  expect(main).toContain("  api_token = var.cloudflare_main_api_token");
  // The deferred wording is gone.
  expect(main).not.toContain("DEFERRED");
});

test("generateInstallationRoot keeps a credential-free alias for a provider without an arg mapping", () => {
  const K8S_TEMPLATE: TemplateDefinition = {
    ...R2_TEMPLATE,
    policy: { ...R2_TEMPLATE.policy, allowedProviders: ["hashicorp/kubernetes"] },
  };
  const { files } = generateInstallationRoot({
    template: K8S_TEMPLATE,
    inputs: { bucketName: "b", accountId: "a", location: "" },
    installType: "opentofu_module",
    providerBindings: [{ provider: "hashicorp/kubernetes", alias: "main" }],
  });
  const main = files["main.tf"]!;
  // kubernetes has no credential arg mapping -> no sensitive var, no wired arg;
  // provider credentials are unsupported until root-only args are mapped.
  expect(main).not.toContain("variable \"kubernetes_compute");
  expect(main).toContain(
    ['provider "kubernetes" {', '  alias = "main"', "}"].join("\n"),
  );
});

test("generateGenericCapsuleRoot wraps arbitrary capsule inputs and outputs", () => {
  const { files } = generateGenericCapsuleRoot({
    requiredProviders: ["cloudflare/cloudflare", "hashicorp/aws"],
    inputs: {
      base_domain: "shota.example.com",
      retries: 3,
      flags: { beta: true, names: ["talk", "files"] },
    },
    outputAllowlist: {
      public_url: { from: "public_url", type: "url" },
      nested: { from: "metadata.hostname", type: "hostname" },
    },
    providerBindings: [
      { provider: "cloudflare/cloudflare", alias: "main" },
      { provider: "hashicorp/aws", alias: "archive" },
    ],
  });

  expect(files["versions.tf"]).toContain('source = "cloudflare/cloudflare"');
  expect(files["main.tf"]).toContain('module "app"');
  expect(files["main.tf"]).toContain('source = "./template-module"');
  expect(files["main.tf"]).toContain('base_domain = "shota.example.com"');
  expect(files["main.tf"]).toContain("retries = 3");
  expect(files["main.tf"]).toContain(
    'flags = jsondecode("{\\"beta\\":true,\\"names\\":[\\"talk\\",\\"files\\"]}")',
  );
  expect(files["main.tf"]).toContain(
    "cloudflare.main = cloudflare.main",
  );
  expect(files["outputs.tf"]).toContain("value = module.app.public_url");
  expect(files["outputs.tf"]).toContain("value = module.app.metadata.hostname");
});

test("generateGenericCapsuleRoot does not materialize provider env set provider blocks", () => {
  const { files } = generateGenericCapsuleRoot({
    requiredProviders: ["registry.opentofu.org/vercel/vercel"],
    inputs: {
      project_name: "talk",
    },
    outputAllowlist: {
      deployment_url: { from: "deployment_url", type: "url" },
    },
  });

  const main = files["main.tf"]!;
  expect(main).not.toContain('provider "vercel"');
  expect(main).not.toContain("vercel_api_token");
  expect(main).toContain('module "app"');
  expect(main).toContain('project_name = "talk"');
});
