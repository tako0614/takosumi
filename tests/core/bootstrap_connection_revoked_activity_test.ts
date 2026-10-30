import { expect, test } from "bun:test";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";
import type { ConnectionVault } from "../../core/adapters/vault/mod.ts";
import { createTakosumiService } from "../../core/bootstrap.ts";
import type { RecordActivityContext } from "../../core/domains/activity/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import { planOwnNotification } from "../../core/domains/notifications/own_notifications.ts";

const NOW = "2026-10-30T00:00:00.000Z";

function connection(id: string): ProviderConnection {
  return {
    id,
    scope: "workspace",
    workspaceId: "ws_revoke",
    ownerAccountId: "tsub_owner",
    provider: "registry.opentofu.org/example/service",
    providerSource: "registry.opentofu.org/example/service",
    secretPartition: "provider-credentials",
    status: "verified",
    materialization: "secret",
    envNames: ["SERVICE_TOKEN"],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function harness() {
  const store = new InMemoryOpenTofuControlStore();
  const recorded: Array<[ActivityEvent, RecordActivityContext | undefined]> = [];
  // The vault's own authority checks are covered elsewhere; this one only
  // deletes the record, as a revoke does before the activity is written.
  const vault = {
    revoke: async (id: string) => await store.deleteConnection(id),
  } as unknown as ConnectionVault;
  const { operations } = await createTakosumiService({
    runtimeEnv: { TAKOSUMI_ENVIRONMENT: "test" },
    opentofuControlStore: store,
    opentofuConnectionVault: vault,
    onActivityRecorded: (event, context) => recorded.push([event, context]),
  });
  return { store, operations, recorded };
}

test("a revoke records the Connection owner only as unstored context for the notification hook", async () => {
  const h = await harness();
  await h.store.putConnection(connection("conn_by_operator"));
  await h.store.putConnection(connection("conn_by_owner"));

  await h.operations.revokeConnection("conn_by_operator", undefined, "tsub_operator");
  await h.operations.revokeConnection("conn_by_owner", undefined, "tsub_owner");
  expect(await h.store.getConnection("conn_by_operator")).toBeUndefined();

  const hooked = h.recorded.filter(([event]) => event.action === "connection.revoked");
  expect(hooked.map(([event, context]) => [event.targetId, context])).toEqual([
    ["conn_by_operator", { ownerAccountId: "tsub_owner", actorAccountId: "tsub_operator" }],
    ["conn_by_owner", { ownerAccountId: "tsub_owner", actorAccountId: "tsub_owner" }],
  ]);
  // Revoked by someone else: the owner is told. By the owner: nobody is.
  expect(planOwnNotification(hooked[0]![0], hooked[0]![1])).toMatchObject({
    kind: "connection.revoked",
    recipients: [{ kind: "account", accountId: "tsub_owner" }],
  });
  expect(planOwnNotification(hooked[1]![0], hooked[1]![1])).toBeUndefined();

  // The stored, public events never name the owner.
  const stored = await h.store.listActivityEvents("ws_revoke", { limit: 10 });
  expect(stored.map((event) => event.targetId).sort()).toEqual(["conn_by_operator", "conn_by_owner"]);
  for (const event of stored) {
    expect(event.metadata).not.toHaveProperty("ownerAccountId");
    expect(JSON.stringify(event)).not.toContain("tsub_owner");
  }
});
