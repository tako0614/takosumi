import { expect, test } from "bun:test";
import {
  parseProviderBinding,
  parseProviderBindings,
} from "../../../../accounts/service/src/control/parse.ts";

test("ProviderBinding parsing keeps current routing fields and deprecated alias", () => {
  const binding = {
    provider: "registry.opentofu.org/hashicorp/aws",
    moduleLocalName: "primary",
    childAlias: "archive",
    rootAlias: "production",
    alias: "legacy",
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

test("ProviderBinding parsing rejects credential-shaped run settings", () => {
  expect(
    parseProviderBinding({
      provider: "registry.terraform.io/tako0614/takoform",
      connectionId: "conn_hosted",
      runCredentialSettings: { authToken: "must-not-cross" },
    }),
  ).toMatchObject({ ok: false });
});

test("ProviderBinding parsing omits malformed optional strings", () => {
  expect(
    parseProviderBinding({
      provider: "registry.opentofu.org/hashicorp/aws",
      moduleLocalName: 42,
      childAlias: null,
      rootAlias: false,
      alias: [],
      connectionId: "conn_1",
      region: {},
    }),
  ).toEqual({
    ok: true,
    binding: {
      provider: "registry.opentofu.org/hashicorp/aws",
      connectionId: "conn_1",
    },
  });
});
