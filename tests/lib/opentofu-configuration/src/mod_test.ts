import { expect, test } from "bun:test";

import {
  compileOpenTofuConfigurationGraph,
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
  expect(result.requirements).toEqual([
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
    {
      source: "registry.opentofu.org/hashicorp/random",
      moduleLocalName: "random",
      version: "3.7.2",
    },
    {
      source: "registry.opentofu.org/hashicorp/time",
      moduleLocalName: "clock",
    },
  ]);
});

test("canonical graph represents zero, one, and N exact identities", () => {
  expect(compile([{ path: "main.tofu", text: 'output "ok" { value = true }' }]))
    .toMatchObject({ complete: true, requirements: [] });

  const one = compile([
    {
      path: "main.tf",
      text: `terraform { required_providers { local = { source = "hashicorp/local" } } }`,
    },
  ]);
  expect(one.requirements).toEqual([
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
  expect(many.requirements).toHaveLength(2);
});

test("generated-root declaration preserves the one exact version proved by its reachable child", () => {
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
  expect(result.requirements).toEqual([
    {
      source: "registry.opentofu.org/hashicorp/random",
      moduleLocalName: "random",
      version: "3.7.2",
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
