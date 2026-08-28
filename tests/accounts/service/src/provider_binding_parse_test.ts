import { expect, test } from "bun:test";
import {
  parseProviderBinding,
  parseProviderBindings,
} from "../../../../accounts/service/src/control/parse.ts";

test("ProviderBinding parsing keeps current routing fields", () => {
  const binding = {
    provider: "registry.opentofu.org/hashicorp/aws",
    moduleLocalName: "primary",
    childAlias: "archive",
    rootAlias: "production",
    connectionId: "conn_1",
    region: "us-east-1",
    runCredentialSettings: {
      resourceName: "bucket-main",
      reservationId: "res_123",
    },
  };

  expect(parseProviderBinding(binding)).toEqual({ ok: true, binding });
  expect(parseProviderBindings([binding])).toEqual({
    ok: true,
    bindings: [binding],
  });
});

test("public ProviderBinding parsing accepts hyphenated OpenTofu identities", () => {
  const binding = {
    provider: "registry.opentofu.org/cloudflare/cloudflare-v02",
    moduleLocalName: "aws-edge",
    childAlias: "cloudflare-v02",
    rootAlias: "aws-edge",
    connectionId: "conn_1",
  };

  expect(parseProviderBinding(binding)).toEqual({ ok: true, binding });
  expect(parseProviderBindings([binding])).toEqual({
    ok: true,
    bindings: [binding],
  });
});

test("public ProviderBinding parsing rejects the deprecated ambiguous alias", () => {
  const binding = {
    provider: "registry.opentofu.org/hashicorp/aws",
    alias: "legacy",
    connectionId: "conn_1",
  };

  expect(parseProviderBinding(binding)).toEqual({
    ok: false,
    message: "alias is deprecated; use childAlias and rootAlias",
  });
  expect(parseProviderBindings([binding])).toEqual({
    ok: false,
    message:
      "bindings[0]: alias is deprecated; use childAlias and rootAlias",
  });
});

test("ProviderBinding parsing rejects credential-shaped run settings", () => {
  expect(
    parseProviderBinding({
      provider: "registry.terraform.io/tako0614/takoform",
      moduleLocalName: "takoform",
      connectionId: "conn_hosted",
      runCredentialSettings: { authToken: "must-not-cross" },
    }),
  ).toEqual({
    ok: false,
    message: "runCredentialSettings.authToken is credential-shaped",
  });
});

test("ProviderBinding parsing rejects OpenTofu builtin runtime capabilities", () => {
  expect(
    parseProviderBinding({
      provider: "terraform.io/builtin/terraform",
      moduleLocalName: "terraform",
      connectionId: "conn_impossible",
    }),
  ).toEqual({
    ok: false,
    message: "OpenTofu builtin providers cannot have ProviderBindings",
  });
});

test("public ProviderBinding parsing requires exact OpenTofu provider identities", () => {
  const baseBinding = {
    provider: "registry.opentofu.org/hashicorp/aws",
    moduleLocalName: "primary",
    connectionId: "conn_1",
  };

  expect(
    parseProviderBinding({
      provider: baseBinding.provider,
      connectionId: baseBinding.connectionId,
    }),
  ).toEqual({
    ok: false,
    message: "moduleLocalName must be a valid OpenTofu identifier",
  });

  for (const [field, value] of [
    ["moduleLocalName", 42],
    ["moduleLocalName", ""],
    ["moduleLocalName", "invalid.alias"],
    ["childAlias", null],
    ["childAlias", ""],
    ["childAlias", "invalid.alias"],
    ["rootAlias", false],
    ["rootAlias", ""],
    ["rootAlias", "invalid.alias"],
  ] as const) {
    expect(parseProviderBinding({ ...baseBinding, [field]: value })).toEqual({
      ok: false,
      message: `${field} must be a valid OpenTofu identifier`,
    });
  }

  // Unrelated optional fields keep their existing coercion behavior.
  expect(
    parseProviderBinding({ ...baseBinding, region: {} }),
  ).toEqual({ ok: true, binding: baseBinding });
});
