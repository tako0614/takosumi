import { expect, test } from "bun:test";

import { generateOpenTofuChildModuleRoot } from "../../../../lib/rootgen/src/mod.ts";

test("rootgen emits only an optional provider-wiring child wrapper", () => {
  const { files } = generateOpenTofuChildModuleRoot({
    requiredProviders: [
      "registry.opentofu.org/cloudflare/cloudflare",
      "providers.example.test/acme/service",
    ],
    inputs: {
      enabled: true,
      nested: { mode: "strict" },
    },
    outputAllowlist: {
      url: { from: "endpoint.url", type: "url" },
      token: { from: "token", type: "string", sensitive: true },
    },
    providerBindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "managed",
        configuration: {
          api_base_url: "https://provider.example.test/client/v4",
        },
      },
    ],
  });

  expect(files["versions.tf"]).toContain(
    'source = "registry.opentofu.org/cloudflare/cloudflare"',
  );
  expect(files["versions.tf"]).toContain(
    'source = "providers.example.test/acme/service"',
  );
  expect(files["versions.tf"]).not.toContain("version =");

  const main = files["main.tf"]!;
  expect(main).toContain('provider "cloudflare" {');
  expect(main).toContain('alias = "managed"');
  expect(main).toContain(
    'api_base_url = "https://provider.example.test/client/v4"',
  );
  expect(main).toContain('module "child" {');
  expect(main).toContain('source = "./module"');
  expect(main).toContain("from = module.app");
  expect(main).toContain("to   = module.child");
  expect(main).toContain("cloudflare = cloudflare.managed");
  expect(main).toContain("enabled = true");
  expect(main).toContain('nested = jsondecode("{\\"mode\\":\\"strict\\"}")');

  const outputs = files["outputs.tf"]!;
  expect(outputs).toContain("value = module.child.endpoint.url");
  expect(outputs).toContain("value = module.child.token");
  expect(outputs).toContain("sensitive = true");
  expect(outputs).not.toContain("try(");
});

test("rootgen keeps an empty wrapper to the child module plus state migration", () => {
  const { files } = generateOpenTofuChildModuleRoot({
    requiredProviders: [],
    inputs: {},
    outputAllowlist: {},
  });

  expect(files["versions.tf"]).toBe("terraform {}\n");
  expect(files["main.tf"]).toContain('module "child" {');
  expect(files["main.tf"]).toContain('source = "./module"');
  expect(files["outputs.tf"]).toBe("");
});

test("rootgen preserves explicit custom registries and rejects bare providers", () => {
  const custom = generateOpenTofuChildModuleRoot({
    requiredProviders: ["providers.example.test/acme/service"],
    inputs: {},
    outputAllowlist: {},
  });
  expect(custom.files["versions.tf"]).not.toContain(
    "registry.opentofu.org/providers.example.test",
  );

  expect(() =>
    generateOpenTofuChildModuleRoot({
      requiredProviders: ["cloudflare"],
      inputs: {},
      outputAllowlist: {},
    }),
  ).toThrow("must declare an explicit namespace/type");
});

test("rootgen escapes HCL interpolation in literal inputs", () => {
  const { files } = generateOpenTofuChildModuleRoot({
    requiredProviders: [],
    inputs: {
      value: 'evil"}\n${file("/etc/passwd")}%{ for x in y }',
    },
    outputAllowlist: {},
  });
  const main = files["main.tf"]!;
  expect(main).toContain(
    'value = "evil\\"}\\n$${file(\\"/etc/passwd\\")}%%{ for x in y }"',
  );
});
