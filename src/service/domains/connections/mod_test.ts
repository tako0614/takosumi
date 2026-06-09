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
