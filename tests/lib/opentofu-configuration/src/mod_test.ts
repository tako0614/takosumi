import { expect, test } from "bun:test";

import {
  compileOpenTofuConfigurationGraph,
  discoverOpenTofuModules,
  parseOpenTofuProviderLockObservation,
  type OpenTofuSourceFile,
} from "../../../../lib/opentofu-configuration/src/mod.ts";

function compile(
  files: readonly OpenTofuSourceFile[],
  selectedModuleDirectory = ".",
) {
  return compileOpenTofuConfigurationGraph({
    selectedModuleDirectory,
    files,
  });
}

test("canonical graph separates reachable provider packages from selected-root binding tuples", () => {
  const result = compile([
    {
      path: "main.tf",
      text: `
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}
module "child" { source = "./modules/child" }
`,
    },
    {
      path: "modules/child/providers.tf",
      text: `
terraform {
  required_providers {
    edge = {
      source = "cloudflare/cloudflare"
      configuration_aliases = [edge.zone]
    }
  }
}
`,
    },
  ]);

  expect(result.providerPackages).toEqual([
    { source: "registry.opentofu.org/cloudflare/cloudflare" },
    { source: "registry.opentofu.org/hashicorp/aws" },
  ]);
  expect(result.rootProviderRequirements).toEqual([
    {
      source: "registry.opentofu.org/hashicorp/aws",
      moduleLocalName: "aws",
    },
  ]);
});

test("selected-root tuples preserve implicit defaults and direct configuration aliases", () => {
  const result = compile([
    {
      path: "main.tf",
      text: `
terraform {
  required_providers {
    edge = {
      source = "cloudflare/cloudflare"
      configuration_aliases = [edge.zone]
    }
  }
}
resource "aws_s3_bucket" "assets" {}
`,
    },
  ]);

  expect(result.rootProviderRequirements).toEqual([
    {
      source: "registry.opentofu.org/cloudflare/cloudflare",
      moduleLocalName: "edge",
    },
    {
      source: "registry.opentofu.org/cloudflare/cloudflare",
      moduleLocalName: "edge",
      childAlias: "zone",
    },
    {
      source: "registry.opentofu.org/hashicorp/aws",
      moduleLocalName: "aws",
    },
  ]);
});

test("selected-root exact versions stay on the direct tuple that declared them", () => {
  const result = compile([
    {
      path: "versions.tf",
      text: `
terraform {
  required_providers {
    primary = { source = "acme/service" version = "= 2.1.0" }
    secondary = { source = "acme/service" version = ">= 2.0" }
  }
}
`,
    },
  ]);

  expect(result.providerPackages).toEqual([
    {
      source: "registry.opentofu.org/acme/service",
      version: "2.1.0",
    },
  ]);
  expect(result.rootProviderRequirements).toEqual([
    {
      source: "registry.opentofu.org/acme/service",
      moduleLocalName: "primary",
      version: "2.1.0",
    },
    {
      source: "registry.opentofu.org/acme/service",
      moduleLocalName: "secondary",
    },
  ]);
});

test("canonical graph fails closed when reachable directories require distinct exact provider versions", () => {
  const result = compile([
    {
      path: "versions.tf",
      text: `terraform { required_providers { aws = { source = "hashicorp/aws" version = "= 5.0.0" } } }`,
    },
    {
      path: "main.tf",
      text: `module "child" { source = "./modules/child" }`,
    },
    {
      path: "modules/child/versions.tf",
      text: `terraform { required_providers { cloud = { source = "hashicorp/aws" version = "= 5.1.0" } } }`,
    },
  ]);

  expect(result.complete).toBe(false);
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "provider_version_constraints_conflict",
      fatal: true,
    }),
  );
  expect(result.providerPackages).toEqual([
    { source: "registry.opentofu.org/hashicorp/aws" },
  ]);
});

test("canonical graph follows only reachable local modules across all four spellings", () => {
  const result = compile(
    [
      {
        path: "capsule/main.tf",
        text: 'module "child" { source = "./modules/child" }\n',
      },
      {
        path: "capsule/providers.tofu",
        text: `
terraform {
  required_providers {
    edge = {
      source = "cloudflare/cloudflare"
      version = "~> 5.0"
      configuration_aliases = [edge.zone, edge.account]
    }
  }
}
`,
      },
      {
        path: "capsule/modules/child/providers.tf.json",
        text: JSON.stringify({
          terraform: {
            required_providers: {
              random: {
                source: "hashicorp/random",
                version: "= 3.7.2",
              },
            },
          },
        }),
      },
      {
        path: "capsule/modules/child/time.tofu.json",
        text: JSON.stringify({
          terraform: {
            required_providers: {
              clock: { source: "hashicorp/time" },
            },
          },
        }),
      },
      {
        path: "sibling/main.tf",
        text: `terraform { required_providers { evil = { source = "attacker/evil" } } }`,
      },
    ],
    "capsule",
  );

  expect(result.complete).toBe(true);
  expect(result.files.map((file) => file.path)).toEqual([
    "capsule/main.tf",
    "capsule/modules/child/providers.tf.json",
    "capsule/modules/child/time.tofu.json",
    "capsule/providers.tofu",
  ]);
  expect(result.providerPackages).toEqual([
    { source: "registry.opentofu.org/cloudflare/cloudflare" },
    {
      source: "registry.opentofu.org/hashicorp/random",
      version: "3.7.2",
    },
    { source: "registry.opentofu.org/hashicorp/time" },
  ]);
  expect(result.rootProviderRequirements).toEqual([
    {
      source: "registry.opentofu.org/cloudflare/cloudflare",
      moduleLocalName: "edge",
    },
    {
      source: "registry.opentofu.org/cloudflare/cloudflare",
      moduleLocalName: "edge",
      childAlias: "account",
    },
    {
      source: "registry.opentofu.org/cloudflare/cloudflare",
      moduleLocalName: "edge",
      childAlias: "zone",
    },
  ]);
});

test("canonical graph represents zero, one, and N exact identities", () => {
  expect(compile([{ path: "main.tofu", text: 'output "ok" { value = true }' }]))
    .toMatchObject({
      complete: true,
      providerPackages: [],
      rootProviderRequirements: [],
    });

  const one = compile([
    {
      path: "main.tf",
      text: `terraform { required_providers { local = { source = "hashicorp/local" } } }`,
    },
  ]);
  expect(one.rootProviderRequirements).toEqual([
    {
      source: "registry.opentofu.org/hashicorp/local",
      moduleLocalName: "local",
    },
  ]);

  const many = compile([
    {
      path: "main.tf",
      text: `terraform { required_providers { service = { source = "acme/service" configuration_aliases = [service.audit] } } }`,
    },
  ]);
  expect(many.rootProviderRequirements).toHaveLength(2);
});

test("reachable child exact version belongs to the package set, not the selected-root tuple", () => {
  const result = compile([
    {
      path: "versions.tf",
      text: `terraform { required_providers { random = { source = "hashicorp/random" } } }`,
    },
    {
      path: "main.tf",
      text: 'module "child" { source = "./module" }',
    },
    {
      path: "module/providers.tf",
      text: `terraform { required_providers { random = { source = "hashicorp/random" version = "= 3.7.2" } } }`,
    },
  ]);
  expect(result.providerPackages).toEqual([
    {
      source: "registry.opentofu.org/hashicorp/random",
      version: "3.7.2",
    },
  ]);
  expect(result.rootProviderRequirements).toEqual([
    {
      source: "registry.opentofu.org/hashicorp/random",
      moduleLocalName: "random",
    },
  ]);
});

test("canonical graph fails closed for malformed JSON, incomplete HCL, missing local modules, and reachable caps", () => {
  const malformedJson = compile([
    { path: "main.tf.json", text: "{ not json" },
  ]);
  expect(malformedJson.complete).toBe(false);
  expect(malformedJson.diagnostics.map((entry) => entry.code)).toContain(
    "json_invalid",
  );

  const incompleteHcl = compile([
    {
      path: "main.tf",
      text: 'terraform { required_providers { aws = { source = "hashicorp/aws" }',
    },
  ]);
  expect(incompleteHcl.complete).toBe(false);
  expect(incompleteHcl.diagnostics.map((entry) => entry.code)).toContain(
    "hcl_incomplete",
  );

  const missing = compile([
    { path: "main.tf", text: 'module "missing" { source = "./missing" }' },
  ]);
  expect(missing.complete).toBe(false);
  expect(missing.diagnostics.map((entry) => entry.code)).toContain(
    "local_module_source_missing",
  );

  const capped = compileOpenTofuConfigurationGraph({
    files: [
      { path: "main.tf", text: 'module "child" { source = "./child" }' },
      { path: "child/main.tf", text: 'output "ok" { value = true }' },
      { path: "sibling/a.tf", text: "# ignored" },
      { path: "sibling/b.tf", text: "# ignored" },
    ],
    limits: { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 },
  });
  expect(capped.complete).toBe(false);
  expect(capped.diagnostics.map((entry) => entry.code)).toContain(
    "file_limit_exceeded",
  );
});

test("canonical graph is code-point deterministic and rejects duplicate source records", () => {
  const files = [
    { path: "z.tofu", text: 'output "z" { value = true }' },
    { path: "a.tf", text: 'output "a" { value = true }' },
  ];
  expect(compile(files).files.map((file) => file.path)).toEqual([
    "a.tf",
    "z.tofu",
  ]);
  const duplicate = compile([files[0]!, files[0]!]);
  expect(duplicate.complete).toBe(false);
  expect(duplicate.diagnostics.map((entry) => entry.code)).toContain(
    "duplicate_source_file",
  );

  const invalid = compile([
    { path: "../outside.tf", text: 'output "no" { value = true }' },
    { path: "main.tf", text: 'output "ok" { value = true }' },
  ]);
  expect(invalid.complete).toBe(false);
  expect(invalid.diagnostics.map((entry) => entry.code)).toContain(
    "source_path_invalid",
  );
});

test("dependency lock observation is canonical, sorted, and fails closed when torn", () => {
  expect(
    parseOpenTofuProviderLockObservation(`
provider "registry.opentofu.org/hashicorp/random" {}
provider "cloudflare/cloudflare" {}
`),
  ).toEqual({
    complete: true,
    sources: [
      "registry.opentofu.org/cloudflare/cloudflare",
      "registry.opentofu.org/hashicorp/random",
    ],
    diagnostics: [],
  });
  expect(
    parseOpenTofuProviderLockObservation(
      'provider "registry.opentofu.org/hashicorp/random" {',
    ),
  ).toMatchObject({
    complete: false,
    diagnostics: [{ code: "dependency_lock_incomplete", fatal: true }],
  });
});

test("module discovery returns zero, one, and independent root modules from real files", () => {
  expect(discoverOpenTofuModules({ files: [] })).toEqual({
    complete: true,
    modules: [],
    diagnostics: [],
  });

  const one = discoverOpenTofuModules({
    files: [
      {
        path: "main.tf",
        text: `module "child" { source = "./modules/child" }`,
      },
      {
        path: "modules/child/providers.tf",
        text: `terraform { required_providers { random = { source = "hashicorp/random" } } }`,
      },
    ],
  });
  expect(one.complete).toBe(true);
  expect(one.modules).toEqual([
    {
      path: ".",
      providerPackages: [
        { source: "registry.opentofu.org/hashicorp/random" },
      ],
      rootProviderRequirements: [],
    },
  ]);

  const many = discoverOpenTofuModules({
    files: [
      { path: "main.tofu", text: `output "root" { value = true }` },
      {
        path: "deploy/takoform/providers.tf.json",
        text: JSON.stringify({
          terraform: {
            required_providers: {
              takoform: { source: "takos/takoform" },
            },
          },
        }),
      },
    ],
  });
  expect(many.complete).toBe(true);
  expect(many.modules.map((module) => module.path)).toEqual([
    ".",
    "deploy/takoform",
  ]);
});

test("module discovery fails closed for ambiguous topology and global scan caps", () => {
  const ambiguous = discoverOpenTofuModules({
    files: [
      {
        path: "main.tf",
        text: `module "dynamic" { source = var.module_source }`,
      },
    ],
  });
  expect(ambiguous.complete).toBe(false);
  expect(ambiguous.modules).toEqual([]);
  expect(ambiguous.diagnostics.map((entry) => entry.code)).toContain(
    "local_module_source_incomplete",
  );

  const capped = discoverOpenTofuModules({
    files: [
      { path: "one/main.tf", text: `output "one" { value = true }` },
      { path: "two/main.tf", text: `output "two" { value = true }` },
    ],
    limits: { maxFiles: 1, maxFileBytes: 1_024, maxTotalBytes: 1_024 },
  });
  expect(capped.complete).toBe(false);
  expect(capped.modules).toEqual([]);
  expect(capped.diagnostics.map((entry) => entry.code)).toContain(
    "file_limit_exceeded",
  );
});

test("module discovery derives implicit providers used by resource, data, and provider blocks", () => {
  const discovered = discoverOpenTofuModules({
    files: [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}
resource "aws_s3_bucket" "assets" {}
data "cloudflare_zone" "primary" {
  provider = cloudflare.account
}
provider "random" {}
output "encoded" {
  value = provider::terraform::encode_expr("ready")
}
`,
      },
    ],
  });

  expect(discovered).toEqual({
    complete: true,
    modules: [
      {
        path: ".",
        providerPackages: [
          { source: "registry.opentofu.org/cloudflare/cloudflare" },
          { source: "registry.opentofu.org/hashicorp/aws" },
          { source: "registry.opentofu.org/hashicorp/random" },
          { source: "terraform.io/builtin/terraform" },
        ],
        rootProviderRequirements: [
          {
            source: "registry.opentofu.org/cloudflare/cloudflare",
            moduleLocalName: "cloudflare",
          },
          {
            source: "registry.opentofu.org/hashicorp/aws",
            moduleLocalName: "aws",
          },
          {
            source: "registry.opentofu.org/hashicorp/random",
            moduleLocalName: "random",
          },
          {
            source: "terraform.io/builtin/terraform",
            moduleLocalName: "terraform",
          },
        ],
      },
    ],
    diagnostics: [],
  });
});

test("module discovery fails closed when a remote module can hide provider requirements", () => {
  const discovered = discoverOpenTofuModules({
    files: [
      {
        path: "main.tf",
        text: `module "network" { source = "hashicorp/consul/aws" }`,
      },
    ],
  });

  expect(discovered.complete).toBe(false);
  expect(discovered.modules).toEqual([]);
  expect(discovered.diagnostics.map((entry) => entry.code)).toContain(
    "remote_module_source_unresolved",
  );
});
