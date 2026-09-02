import { expect, test } from "bun:test";

import {
  generateOpenTofuChildModuleRoot,
  ROOT_RUNTIME_INPUTS_VARIABLE_PREFIX,
  rootRuntimeInputsVariableName,
  RootgenValidationError,
} from "../../../../lib/rootgen/src/mod.ts";

test("rootgen keys provider declarations and mappings only from selected-root tuples", () => {
  const { files } = generateOpenTofuChildModuleRoot({
    rootProviderRequirements: [
      {
        source: "registry.opentofu.org/hashicorp/aws",
        moduleLocalName: "aws",
      },
    ],
    inputs: {},
    outputAllowlist: {},
    providerBindings: [
      {
        provider: "registry.opentofu.org/hashicorp/aws",
        moduleLocalName: "aws",
      },
    ],
  });

  expect(files["versions.tf"]).toContain(
    'source = "registry.opentofu.org/hashicorp/aws"',
  );
  expect(files["versions.tf"]).not.toContain("cloudflare");
  expect(files["main.tf"]).toContain("aws = aws");
  expect(files["main.tf"]).not.toContain("cloudflare");
});

test("rootgen renders exact selected-root provider versions", () => {
  const { files } = generateOpenTofuChildModuleRoot({
    rootProviderRequirements: [
      {
        source: "registry.opentofu.org/hashicorp/aws",
        moduleLocalName: "aws",
        version: "3.0.0",
      },
    ],
    inputs: {},
    outputAllowlist: {},
  });

  expect(files["versions.tf"]).toContain(
    'aws = {\n      source = "registry.opentofu.org/hashicorp/aws"\n      version = "= 3.0.0"\n    }',
  );
});

test("rootgen omits provider versions when selected-root tuples have none", () => {
  const { files } = generateOpenTofuChildModuleRoot({
    rootProviderRequirements: [
      {
        source: "registry.opentofu.org/hashicorp/aws",
        moduleLocalName: "aws",
      },
    ],
    inputs: {},
    outputAllowlist: {},
  });

  expect(files["versions.tf"]).not.toContain("version =");
});

test("rootgen rejects a binding that has no exact selected-root tuple", () => {
  let thrown: unknown;
  try {
    generateOpenTofuChildModuleRoot({
      rootProviderRequirements: [
        {
          source: "registry.opentofu.org/hashicorp/aws",
          moduleLocalName: "aws",
        },
      ],
      inputs: {},
      outputAllowlist: {},
      providerBindings: [
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          moduleLocalName: "cloudflare",
        },
      ],
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({
    code: "invalid_argument",
    details: {
      reason: "rootgen_provider_binding_outside_root_requirements",
    },
  });
});

test("rootgen emits only an optional provider-wiring child wrapper", () => {
  const { files } = generateOpenTofuChildModuleRoot({
    rootProviderRequirements: [
      {
        source: "registry.opentofu.org/cloudflare/cloudflare",
        moduleLocalName: "cloudflare",
      },
      {
        source: "providers.example.test/acme/service",
        moduleLocalName: "service",
      },
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
        moduleLocalName: "cloudflare",
        rootAlias: "managed",
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

test("rootgen preserves module-local names and maps child/root aliases independently", () => {
  const { files } = generateOpenTofuChildModuleRoot({
    rootProviderRequirements: [
      {
        source: "registry.opentofu.org/acme/service",
        moduleLocalName: "primary",
      },
      {
        source: "registry.opentofu.org/acme/service",
        moduleLocalName: "primary",
        childAlias: "archive",
      },
      {
        source: "registry.opentofu.org/other/service",
        moduleLocalName: "secondary",
      },
    ],
    inputs: {},
    outputAllowlist: {},
    providerBindings: [
      {
        provider: "registry.opentofu.org/acme/service",
        moduleLocalName: "primary",
        childAlias: "archive",
        rootAlias: "credentials",
      },
    ],
  });

  expect(files["versions.tf"]).toContain(
    'primary = {\n      source = "registry.opentofu.org/acme/service"',
  );
  expect(files["versions.tf"]).toContain(
    'secondary = {\n      source = "registry.opentofu.org/other/service"',
  );
  expect(files["versions.tf"]?.match(/\bservice = \{/gu)).toBeNull();
  expect(files["main.tf"]).toContain('provider "primary" {');
  expect(files["main.tf"]).toContain('alias = "credentials"');
  expect(files["main.tf"]).toContain("primary.archive = primary.credentials");
  expect(files["main.tf"]).not.toContain(
    "primary.credentials = primary.credentials",
  );
});

test("rootgen accepts hyphenated provider identifiers in generated mappings", () => {
  const { files } = generateOpenTofuChildModuleRoot({
    rootProviderRequirements: [
      {
        source: "registry.opentofu.org/cloudflare/cloudflare",
        moduleLocalName: "cloudflare-v02",
        childAlias: "aws-edge",
      },
      {
        source: "registry.opentofu.org/hashicorp/aws",
        moduleLocalName: "aws-edge",
      },
    ],
    inputs: {},
    outputAllowlist: {},
    providerBindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        moduleLocalName: "cloudflare-v02",
        childAlias: "aws-edge",
        rootAlias: "aws-edge",
      },
      {
        provider: "registry.opentofu.org/hashicorp/aws",
        moduleLocalName: "aws-edge",
      },
    ],
  });

  expect(files["versions.tf"]).toContain(
    'cloudflare-v02 = {\n      source = "registry.opentofu.org/cloudflare/cloudflare"',
  );
  expect(files["versions.tf"]).toContain(
    'aws-edge = {\n      source = "registry.opentofu.org/hashicorp/aws"',
  );
  const main = files["main.tf"]!;
  expect(main).toContain('provider "cloudflare-v02" {');
  expect(main).toContain('alias = "aws-edge"');
  expect(main).toContain('provider "aws-edge" {');
  expect(main).toContain("cloudflare-v02.aws-edge = cloudflare-v02.aws-edge");
  expect(main).toContain("aws-edge = aws-edge");
});

test("rootgen keeps every default child provider mapped when one provider needs explicit configuration", () => {
  const { files } = generateOpenTofuChildModuleRoot({
    rootProviderRequirements: [
      {
        source: "registry.opentofu.org/cloudflare/cloudflare",
        moduleLocalName: "cloudflare",
      },
      {
        source: "registry.opentofu.org/hashicorp/random",
        moduleLocalName: "random",
      },
      {
        source: "registry.opentofu.org/hashicorp/random",
        moduleLocalName: "random",
        childAlias: "seeded",
      },
      {
        source: "registry.opentofu.org/hashicorp/tls",
        moduleLocalName: "tls",
      },
    ],
    inputs: {},
    outputAllowlist: {},
    providerBindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        moduleLocalName: "cloudflare",
        configuration: { api_base_url: "https://api.example.test" },
      },
    ],
  });

  expect(files["main.tf"]).toContain("cloudflare = cloudflare");
  expect(files["main.tf"]).toContain("random = random");
  expect(files["main.tf"]).toContain("random.seeded = random");
  expect(files["main.tf"]).toContain("tls = tls");
});

test("rootgen omits built-in runtime capabilities from declarations and mappings", () => {
  const { files } = generateOpenTofuChildModuleRoot({
    rootProviderRequirements: [
      {
        source: "registry.opentofu.org/cloudflare/cloudflare",
        moduleLocalName: "cloudflare",
      },
      {
        source: "registry.opentofu.org/hashicorp/random",
        moduleLocalName: "random",
      },
      {
        source: "registry.opentofu.org/hashicorp/tls",
        moduleLocalName: "tls",
      },
      {
        source: "terraform.io/builtin/terraform",
        moduleLocalName: "terraform",
      },
    ],
    inputs: {},
    outputAllowlist: {},
    providerBindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        moduleLocalName: "cloudflare",
      },
      {
        provider: "terraform.io/builtin/terraform",
        moduleLocalName: "terraform",
      },
    ],
  });

  const versions = files["versions.tf"]!;
  expect(versions).toContain(
    'source = "registry.opentofu.org/cloudflare/cloudflare"',
  );
  expect(versions).toContain(
    'source = "registry.opentofu.org/hashicorp/random"',
  );
  expect(versions).toContain(
    'source = "registry.opentofu.org/hashicorp/tls"',
  );
  expect(versions).not.toContain("terraform.io/builtin/terraform");
  expect(versions).not.toContain("terraform = {");

  const main = files["main.tf"]!;
  expect(main).toContain("cloudflare = cloudflare");
  expect(main).toContain("random = random");
  expect(main).toContain("tls = tls");
  expect(main).not.toContain('provider "terraform"');
  expect(main).not.toContain("terraform = terraform");
});

test("rootgen rejects two sources claiming the same explicit local name", () => {
  expect(() =>
    generateOpenTofuChildModuleRoot({
      rootProviderRequirements: [
        {
          source: "registry.opentofu.org/acme/service",
          moduleLocalName: "service",
        },
        {
          source: "registry.opentofu.org/other/service",
          moduleLocalName: "service",
        },
      ],
      inputs: {},
      outputAllowlist: {},
    }),
  ).toThrow(
    "rootgen: provider local name service maps to both registry.opentofu.org/acme/service and registry.opentofu.org/other/service",
  );
});

test("rootgen keeps an empty wrapper to the child module plus state migration", () => {
  const { files } = generateOpenTofuChildModuleRoot({
    rootProviderRequirements: [],
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
    rootProviderRequirements: [
      {
        source: "providers.example.test/acme/service",
        moduleLocalName: "service",
      },
    ],
    inputs: {},
    outputAllowlist: {},
  });
  expect(custom.files["versions.tf"]).not.toContain(
    "registry.opentofu.org/providers.example.test",
  );

  let thrown: unknown;
  try {
    generateOpenTofuChildModuleRoot({
      rootProviderRequirements: [
        { source: "cloudflare", moduleLocalName: "cloudflare" },
      ],
      inputs: {},
      outputAllowlist: {},
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RootgenValidationError);
  expect(thrown).toMatchObject({
    name: "RootgenValidationError",
    code: "invalid_argument",
    message:
      "rootgen: provider cloudflare must declare an explicit namespace/type or hostname/namespace/type source",
    details: { reason: "rootgen_explicit_provider_source_required" },
  });
});

test("rootgen escapes HCL interpolation in literal inputs", () => {
  const { files } = generateOpenTofuChildModuleRoot({
    rootProviderRequirements: [],
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

test("rootgen validation reasons are stable and layer-neutral", () => {
  const cases = [
    {
      input: {
        rootProviderRequirements: [],
        inputs: { "invalid.name": true },
        outputAllowlist: {},
      },
      reason: "rootgen_invalid_identifier",
    },
    {
      input: {
        rootProviderRequirements: [
          {
            source: "cloudflare/cloudflare",
            moduleLocalName: "cloudflare",
          },
        ],
        inputs: {},
        outputAllowlist: {},
        providerBindings: [
          {
            provider: "cloudflare/cloudflare",
            moduleLocalName: "cloudflare",
            configuration: { alias: "forbidden" },
          },
        ],
      },
      reason: "rootgen_provider_configuration_alias_override",
    },
    {
      input: {
        rootProviderRequirements: [],
        inputs: { value: Number.POSITIVE_INFINITY },
        outputAllowlist: {},
      },
      reason: "rootgen_non_finite_number_input",
    },
  ] as const;

  for (const fixture of cases) {
    let thrown: unknown;
    try {
      generateOpenTofuChildModuleRoot(fixture.input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RootgenValidationError);
    expect(thrown).toMatchObject({
      code: "invalid_argument",
      details: { reason: fixture.reason },
    });
  }
});

const TAKOFORM = "registry.opentofu.org/tako0614/takoform";
const CLOUDFLARE = "registry.opentofu.org/cloudflare/cloudflare";
const NONCE_A = "8Jd1nQ2vK7pR4sT6wX9zB0cE3fH5jL8mN1qS4uV7yA0";
const NONCE_B = "Q2vK7pR4sT6wX9zB0cE3fH5jL8mN1qS4uV7yA8Jd1n0";

function runtimeInputRootInput() {
  return {
    rootProviderRequirements: [
      { source: TAKOFORM, moduleLocalName: "takoform" },
      { source: TAKOFORM, moduleLocalName: "takoform", childAlias: "edge" },
      { source: CLOUDFLARE, moduleLocalName: "cloudflare" },
    ],
    inputs: {},
    outputAllowlist: {},
    providerBindings: [
      {
        provider: TAKOFORM,
        moduleLocalName: "takoform",
        configuration: { endpoint: "https://forms.example.com" },
        runtimeInputs: {
          nonce: NONCE_A,
          nonceArgument: "runtime_input_nonce",
          mapArgument: "runtime_inputs",
        },
      },
      {
        provider: TAKOFORM,
        moduleLocalName: "takoform",
        childAlias: "edge",
        rootAlias: "edge",
        runtimeInputs: {
          nonce: NONCE_B,
          nonceArgument: "runtime_input_nonce",
          mapArgument: "runtime_inputs",
        },
      },
      {
        provider: CLOUDFLARE,
        moduleLocalName: "cloudflare",
        configuration: { account_id: "abc123" },
      },
    ],
  } as const;
}

test("rootgen declares one ephemeral sensitive map per declaring provider instance", () => {
  const { files } = generateOpenTofuChildModuleRoot({
    rootProviderRequirements: [
      { source: TAKOFORM, moduleLocalName: "takoform" },
    ],
    inputs: {},
    outputAllowlist: {},
    providerBindings: [
      {
        provider: TAKOFORM,
        moduleLocalName: "takoform",
        runtimeInputs: {
          nonce: NONCE_A,
          nonceArgument: "runtime_input_nonce",
          mapArgument: "runtime_inputs",
        },
      },
    ],
  });

  expect(files["variables.tf"]).toContain(
    'variable "takosumi_runtime_inputs__takoform" {',
  );
  expect(files["variables.tf"]).toContain("  type      = map(string)");
  expect(files["variables.tf"]).toContain("  sensitive = true");
  expect(files["variables.tf"]).toContain("  ephemeral = true");
  // A default would let a dropped map silently become an empty one.
  expect(files["variables.tf"]).not.toContain("default   =");
  expect(files["main.tf"]).toContain(
    [
      'provider "takoform" {',
      `  runtime_input_nonce = "${NONCE_A}"`,
      "  runtime_inputs = var.takosumi_runtime_inputs__takoform",
      "}",
    ].join("\n"),
  );
});

test("rootgen keeps run-scoped sensitive inputs on their exact provider instance", () => {
  const { files } = generateOpenTofuChildModuleRoot(runtimeInputRootInput());

  expect(files["variables.tf"]).toContain(
    'variable "takosumi_runtime_inputs__takoform" {',
  );
  expect(files["variables.tf"]).toContain(
    'variable "takosumi_runtime_inputs__takoform__edge" {',
  );
  expect(files["main.tf"]).toContain(
    "  runtime_inputs = var.takosumi_runtime_inputs__takoform\n",
  );
  expect(files["main.tf"]).toContain(
    "  runtime_inputs = var.takosumi_runtime_inputs__takoform__edge\n",
  );

  // The non-declaring provider block receives neither argument.
  const cloudflareBlock = files["main.tf"]!.slice(
    files["main.tf"]!.indexOf('provider "cloudflare"'),
  );
  expect(cloudflareBlock).not.toContain("runtime_input_nonce");
  expect(cloudflareBlock).not.toContain("runtime_inputs");

  // Generation is deterministic.
  const again = generateOpenTofuChildModuleRoot(runtimeInputRootInput());
  expect(again.files).toEqual(files);
});

test("rootgen emits no variables.tf when no provider instance declares inputs", () => {
  const { files } = generateOpenTofuChildModuleRoot({
    rootProviderRequirements: [
      { source: CLOUDFLARE, moduleLocalName: "cloudflare" },
    ],
    inputs: { app_name: "demo" },
    outputAllowlist: { message: { from: "message", type: "string" } },
    providerBindings: [
      {
        provider: CLOUDFLARE,
        moduleLocalName: "cloudflare",
        configuration: { account_id: "abc123" },
      },
    ],
  });

  expect(Object.keys(files).sort()).toEqual([
    "main.tf",
    "outputs.tf",
    "versions.tf",
  ]);
  expect(files["main.tf"]).not.toContain("takosumi_runtime_inputs__");
});

test("rootRuntimeInputsVariableName is the shared Core/runner derivation", () => {
  expect(rootRuntimeInputsVariableName({ moduleLocalName: "takoform" })).toBe(
    "takosumi_runtime_inputs__takoform",
  );
  expect(
    rootRuntimeInputsVariableName({
      moduleLocalName: "takoform",
      rootAlias: "edge",
    }),
  ).toBe("takosumi_runtime_inputs__takoform__edge");
  expect(
    rootRuntimeInputsVariableName({ moduleLocalName: "takoform" }).startsWith(
      ROOT_RUNTIME_INPUTS_VARIABLE_PREFIX,
    ),
  ).toBe(true);
});

test("rootgen rejects unusable run-scoped sensitive input wiring", () => {
  const cases = [
    {
      runtimeInputs: {
        nonce: "too-short",
        nonceArgument: "runtime_input_nonce",
        mapArgument: "runtime_inputs",
      },
      configuration: undefined,
      reason: "rootgen_runtime_input_nonce_invalid",
    },
    {
      runtimeInputs: {
        nonce: `${NONCE_A}!`,
        nonceArgument: "runtime_input_nonce",
        mapArgument: "runtime_inputs",
      },
      configuration: undefined,
      reason: "rootgen_runtime_input_nonce_invalid",
    },
    {
      runtimeInputs: {
        nonce: NONCE_A,
        nonceArgument: "alias",
        mapArgument: "runtime_inputs",
      },
      configuration: undefined,
      reason: "rootgen_runtime_input_argument_invalid",
    },
    {
      runtimeInputs: {
        nonce: NONCE_A,
        nonceArgument: "runtime_input_nonce",
        mapArgument: "not an identifier",
      },
      configuration: undefined,
      reason: "rootgen_runtime_input_argument_invalid",
    },
    {
      runtimeInputs: {
        nonce: NONCE_A,
        nonceArgument: "runtime_inputs",
        mapArgument: "runtime_inputs",
      },
      configuration: undefined,
      reason: "rootgen_runtime_input_argument_conflict",
    },
    {
      runtimeInputs: {
        nonce: NONCE_A,
        nonceArgument: "runtime_input_nonce",
        mapArgument: "runtime_inputs",
      },
      configuration: { runtime_inputs: "smuggled" },
      reason: "rootgen_runtime_input_argument_conflict",
    },
  ] as const;

  for (const fixture of cases) {
    let thrown: unknown;
    try {
      generateOpenTofuChildModuleRoot({
        rootProviderRequirements: [
          { source: TAKOFORM, moduleLocalName: "takoform" },
        ],
        inputs: {},
        outputAllowlist: {},
        providerBindings: [
          {
            provider: TAKOFORM,
            moduleLocalName: "takoform",
            ...(fixture.configuration
              ? { configuration: fixture.configuration }
              : {}),
            runtimeInputs: fixture.runtimeInputs,
          },
        ],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RootgenValidationError);
    expect(thrown).toMatchObject({
      code: "invalid_argument",
      details: { reason: fixture.reason },
    });
  }
});
