/**
 * Capability binding resolution matrix (core-spec.md §9): default /
 * connection / manual / disabled across operator defaults and space
 * connections, including the cross-space rejection and the operator-default
 * fallback for unbound capabilities.
 */
import { expect, test } from "bun:test";

import type { Connection } from "takosumi-contract/deploy-control-api";
import { InMemoryOpenTofuDeploymentStore } from "../deploy-control/store.ts";
import { seedInstallationModel } from "../deploy-control/test_model_fixture.ts";
import {
  ConnectionsService,
  mintableConnectionIds,
} from "./mod.ts";

const NOW = "2026-06-06T00:00:00.000Z";

function connection(input: {
  readonly id: string;
  readonly scope: "operator" | "space";
  readonly spaceId?: string;
  readonly provider?: string;
}): Connection {
  return {
    id: input.id,
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    provider: input.provider ?? "cloudflare",
    kind: "provider",
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

test("unbound capabilities resolve to the operator default (spec §9)", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "conn_op_cf", scope: "operator" }),
  );
  await service.putOperatorConnectionDefault({
    capability: "compute",
    connectionId: "conn_op_cf",
  });

  const resolved = await service.resolveCapabilities(model.installation);
  const compute = resolved.find((r) => r.capability === "compute");
  expect(compute?.mode).toBe("default");
  expect(compute?.connection?.id).toBe("conn_op_cf");
  // No operator default for dns -> default mode with no connection.
  const dns = resolved.find((r) => r.capability === "dns");
  expect(dns?.mode).toBe("default");
  expect(dns?.connection).toBeUndefined();
});

test("connection / manual / disabled bindings resolve per mode", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({
      id: "conn_space_dns",
      scope: "space",
      spaceId: model.space.id,
    }),
  );
  await store.putDeploymentProfile({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: {
      dns: { mode: "connection", connectionId: "conn_space_dns" },
      storage: {
        mode: "manual",
        values: { type: "CNAME", name: "talk.example.com" },
      },
      database: { mode: "disabled" },
    },
    createdAt: NOW,
    updatedAt: NOW,
  });

  const resolved = await service.resolveCapabilities(model.installation);
  expect(
    resolved.find((r) => r.capability === "dns")?.connection?.id,
  ).toBe("conn_space_dns");
  expect(resolved.find((r) => r.capability === "storage")).toEqual({
    capability: "storage",
    mode: "manual",
    values: { type: "CNAME", name: "talk.example.com" },
  });
  expect(resolved.find((r) => r.capability === "database")).toEqual({
    capability: "database",
    mode: "disabled",
  });
  // mintableConnectionIds carries connection/default resolutions only.
  expect(mintableConnectionIds(resolved)).toEqual(["conn_space_dns"]);
});

test("a space connection from ANOTHER space is rejected", async () => {
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
    bindings: {
      compute: { mode: "connection", connectionId: "conn_other_space" },
    },
    createdAt: NOW,
    updatedAt: NOW,
  });
  await expect(service.resolveCapabilities(model.installation)).rejects
    .toThrow(/belongs to another space/);
});

test("operator defaults require an operator-scoped connection", async () => {
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
      capability: "compute",
      connectionId: "conn_space_cf",
    }),
  ).rejects.toThrow(/operator-scoped/);
  // One default per capability: the second put replaces the first.
  await store.putConnection(connection({ id: "conn_op_1", scope: "operator" }));
  await store.putConnection(connection({ id: "conn_op_2", scope: "operator" }));
  await service.putOperatorConnectionDefault({
    capability: "compute",
    connectionId: "conn_op_1",
  });
  await service.putOperatorConnectionDefault({
    capability: "compute",
    connectionId: "conn_op_2",
  });
  const defaults = await service.listOperatorConnectionDefaults();
  expect(defaults).toHaveLength(1);
  expect(defaults[0]?.connectionId).toBe("conn_op_2");
});

test("binding mode connection without a connectionId is rejected", async () => {
  const { store, model, service } = await setup();
  await store.putDeploymentProfile({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: { compute: { mode: "connection" } },
    createdAt: NOW,
    updatedAt: NOW,
  });
  await expect(service.resolveCapabilities(model.installation)).rejects
    .toThrow(/without a connectionId/);
});
