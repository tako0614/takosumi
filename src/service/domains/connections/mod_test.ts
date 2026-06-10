/**
 * Provider binding resolution matrix: default / connection / manual / disabled
 * across Takosumi-provided defaults and Space connections.
 */
import { expect, test } from "bun:test";

import type { Connection } from "@takosumi/internal/deploy-control-api";
import { InMemoryOpenTofuDeploymentStore } from "../deploy-control/store.ts";
import { seedInstallationModel } from "../deploy-control/test_model_fixture.ts";
import { ConnectionsService, mintableConnectionIds } from "./mod.ts";

const NOW = "2026-06-06T00:00:00.000Z";

function connection(input: {
  readonly id: string;
  readonly scope: "operator" | "space";
  readonly spaceId?: string;
  readonly provider?: string;
}): Connection {
  const provider = input.provider ?? "cloudflare";
  return {
    id: input.id,
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    provider,
    kind: provider === "aws" ? "aws_assume_role" : "cloudflare_api_token",
    scope: input.scope,
    authMethod: "static_secret",
    status: "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function setup() {
  const store = new InMemoryOpenTofuDeploymentStore();
  const model = await seedInstallationModel(store);
  const service = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_1`,
    now: () => NOW,
  });
  return { store, model, service };
}

test("default provider binding resolves to the provider default", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(connection({ id: "conn_op_cf", scope: "operator" }));
  await service.putOperatorConnectionDefault({
    provider: "cloudflare",
    connectionId: "conn_op_cf",
  });
  await store.putDeploymentProfile({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [{ provider: "cloudflare", alias: "main", mode: "default" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const resolved = await service.resolveProviderBindings(model.installation);
  expect(resolved).toEqual([
    {
      provider: "cloudflare",
      alias: "main",
      mode: "default",
      connection: await store.getConnection("conn_op_cf"),
    },
  ]);
});

test("connection / manual / disabled provider bindings resolve per mode", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({
      id: "conn_space_cf",
      scope: "space",
      spaceId: model.space.id,
    }),
  );
  await store.putDeploymentProfile({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        mode: "connection",
        connectionId: "conn_space_cf",
      },
      {
        provider: "hashicorp/aws",
        alias: "archive",
        mode: "manual",
        values: { bucket: "manual-bucket" },
      },
      {
        provider: "hashicorp/postgresql",
        alias: "db",
        mode: "disabled",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const resolved = await service.resolveProviderBindings(model.installation);
  expect(resolved[0]?.connection?.id).toBe("conn_space_cf");
  expect(resolved[1]).toEqual({
    provider: "hashicorp/aws",
    alias: "archive",
    mode: "manual",
    values: { bucket: "manual-bucket" },
  });
  expect(resolved[2]).toEqual({
    provider: "hashicorp/postgresql",
    alias: "db",
    mode: "disabled",
  });
  expect(mintableConnectionIds(resolved)).toEqual(["conn_space_cf"]);
});

test("a space connection from another space is rejected", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({
      id: "conn_other_space",
      scope: "space",
      spaceId: "space_other",
    }),
  );
  await store.putDeploymentProfile({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        mode: "connection",
        connectionId: "conn_other_space",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });
  await expect(service.resolveProviderBindings(model.installation)).rejects
    .toThrow(/belongs to another space/);
});

test("provider defaults require an operator-scoped connection", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({
      id: "conn_space_cf",
      scope: "space",
      spaceId: model.space.id,
    }),
  );
  await expect(
    service.putOperatorConnectionDefault({
      provider: "cloudflare",
      connectionId: "conn_space_cf",
    }),
  ).rejects.toThrow(/operator-scoped/);

  await store.putConnection(connection({ id: "conn_op_1", scope: "operator" }));
  await store.putConnection(connection({ id: "conn_op_2", scope: "operator" }));
  await service.putOperatorConnectionDefault({
    provider: "cloudflare",
    connectionId: "conn_op_1",
  });
  await service.putOperatorConnectionDefault({
    provider: "cloudflare",
    connectionId: "conn_op_2",
  });
  const defaults = await service.listOperatorConnectionDefaults();
  expect(defaults).toHaveLength(1);
  expect(defaults[0]?.connectionId).toBe("conn_op_2");
});

test("connection mode without a connectionId is rejected", async () => {
  const { store, model, service } = await setup();
  await store.putDeploymentProfile({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [{ provider: "cloudflare", mode: "connection" }],
    createdAt: NOW,
    updatedAt: NOW,
  });
  await expect(service.resolveProviderBindings(model.installation)).rejects
    .toThrow(/without a connectionId/);
});

test("managed-default status is unavailable with no operator default", async () => {
  const { service } = await setup();
  const status = await service.getManagedDefaultStatus();
  expect(status).toEqual({ available: false, providers: [] });
});

test("managed-default status projects covered providers without credentials", async () => {
  const { store } = await setup();
  // Distinct ids per default (the shared setup pins newId to `ocd_1`, which
  // would otherwise collide the two defaults onto one row).
  let n = 0;
  const service = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_${++n}`,
    now: () => NOW,
  });
  await store.putConnection(connection({ id: "conn_op_cf", scope: "operator" }));
  await store.putConnection(
    connection({ id: "conn_op_aws", scope: "operator", provider: "aws" }),
  );
  await service.putOperatorConnectionDefault({
    provider: "cloudflare",
    connectionId: "conn_op_cf",
  });
  await service.putOperatorConnectionDefault({
    provider: "aws",
    connectionId: "conn_op_aws",
  });

  const status = await service.getManagedDefaultStatus();
  // Sorted, de-duplicated provider names; available true; and — crucially — the
  // projection carries NO connection id / value field (no `connectionId`, no
  // `id`), so the operator key never leaks through this signal.
  expect(status).toEqual({ available: true, providers: ["aws", "cloudflare"] });
  expect(JSON.stringify(status)).not.toContain("conn_op_cf");
  expect(JSON.stringify(status)).not.toContain("connectionId");
});

// --- resolveProviderBindingsForRun: the operator-default fall-through (§7.1) ---
// The documented ProviderBinding contract: "an empty ProviderBindings list
// ALWAYS resolves to `default` and falls through to the operator key." These
// pin that contract so a no-config managed install actually mints the operator
// credential (the panpii path) instead of running with no provider token.

test("a required provider with no explicit binding falls through to the operator default", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(connection({ id: "conn_op_cf", scope: "operator" }));
  await service.putOperatorConnectionDefault({
    provider: "cloudflare",
    connectionId: "conn_op_cf",
  });
  // No DeploymentProfile at all (the no-config managed install path). The run's
  // required provider arrives as a canonical registry address, while the
  // operator default is registered under the short name — the fall-through must
  // match across the two forms.
  const resolved = await service.resolveProviderBindingsForRun(
    model.installation,
    ["registry.opentofu.org/cloudflare/cloudflare"],
  );
  expect(resolved).toEqual([
    {
      provider: "cloudflare",
      mode: "default",
      connection: await store.getConnection("conn_op_cf"),
    },
  ]);
  // The operator default flows into the credential mint pool, so apply actually
  // gets the operator key.
  expect(mintableConnectionIds(resolved)).toEqual(["conn_op_cf"]);
});

test("the operator-default fall-through is fail-closed without an operator default", async () => {
  const { model, service } = await setup();
  const resolved = await service.resolveProviderBindingsForRun(
    model.installation,
    ["cloudflare"],
  );
  // No operator default for the provider -> nothing synthesized, no credential.
  expect(resolved).toEqual([]);
  expect(mintableConnectionIds(resolved)).toEqual([]);
});

test("an explicit disabled binding is not overridden by the fall-through", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(connection({ id: "conn_op_cf", scope: "operator" }));
  await service.putOperatorConnectionDefault({
    provider: "cloudflare",
    connectionId: "conn_op_cf",
  });
  await store.putDeploymentProfile({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [{ provider: "cloudflare", mode: "disabled" }],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const resolved = await service.resolveProviderBindingsForRun(
    model.installation,
    ["registry.opentofu.org/cloudflare/cloudflare"],
  );
  // The explicit disabled binding stands; no operator default is synthesized.
  expect(resolved).toEqual([{ provider: "cloudflare", mode: "disabled" }]);
  expect(mintableConnectionIds(resolved)).toEqual([]);
});

test("an explicit Space connection wins; the provider is not also defaulted", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(connection({ id: "conn_op_cf", scope: "operator" }));
  await service.putOperatorConnectionDefault({
    provider: "cloudflare",
    connectionId: "conn_op_cf",
  });
  await store.putConnection(
    connection({ id: "conn_space_cf", scope: "space", spaceId: model.space.id }),
  );
  await store.putDeploymentProfile({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        mode: "connection",
        connectionId: "conn_space_cf",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const resolved = await service.resolveProviderBindingsForRun(
    model.installation,
    ["cloudflare"],
  );
  // Exactly one binding: the user's own Space connection. No duplicate operator
  // default for the same provider.
  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.connection?.id).toBe("conn_space_cf");
  expect(mintableConnectionIds(resolved)).toEqual(["conn_space_cf"]);
});

test("no required providers leaves the explicit bindings unchanged", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(connection({ id: "conn_op_cf", scope: "operator" }));
  await service.putOperatorConnectionDefault({
    provider: "cloudflare",
    connectionId: "conn_op_cf",
  });
  const resolved = await service.resolveProviderBindingsForRun(
    model.installation,
    [],
  );
  expect(resolved).toEqual([]);
});
