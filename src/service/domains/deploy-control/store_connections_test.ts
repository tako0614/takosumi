/**
 * Connection + secret-blob store symmetry: the in-memory twin and the D1-shaped
 * store must behave identically for the credential-core methods.
 */
import { expect, test } from "bun:test";

import {
  InMemoryOpenTofuDeploymentStore,
  type OpenTofuDeploymentStore,
  type StoredSecretBlob,
} from "./store.ts";
import { CloudflareD1OpenTofuDeploymentStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "./sqlite_fake_d1.ts";
import type { Connection } from "takosumi-contract/deploy-control-api";
import type { ActivityEvent } from "takosumi-contract/activity";

// -- Fixtures ------------------------------------------------------------------

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn_abcdef0123456789",
    spaceId: "space_1",
    provider: "cloudflare",
    owner: "customer",
    authMethod: "static_secret",
    status: "pending",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    ...overrides,
  };
}

function secretBlob(connectionId: string): StoredSecretBlob {
  return {
    connectionId,
    ciphertext: "Y2lwaGVydGV4dA==",
    iv: "aXZpdml2aXZpdg==",
    keyVersion: "secret-boundary-aes-gcm/v1/cloudflare",
    aad: {
      cloudPartition: "cloudflare",
      spaceId: "space_1",
      provider: "cloudflare",
    },
  };
}

const STORES: ReadonlyArray<[string, () => OpenTofuDeploymentStore]> = [
  ["in-memory", () => new InMemoryOpenTofuDeploymentStore()],
  ["d1", () => new CloudflareD1OpenTofuDeploymentStore(new SqliteFakeD1())],
];

for (const [name, make] of STORES) {
  test(`${name}: connection put/get/list/delete round-trip`, async () => {
    const store = make();
    const conn = connection();
    await store.putConnection(conn);

    expect(await store.getConnection(conn.id)).toEqual(conn);

    const other = connection({ id: "conn_zzzzzzzz11111111", spaceId: "space_2" });
    await store.putConnection(other);

    const inSpace1 = await store.listConnections("space_1");
    expect(inSpace1.map((c) => c.id)).toEqual([conn.id]);
    const inSpace2 = await store.listConnections("space_2");
    expect(inSpace2.map((c) => c.id)).toEqual([other.id]);

    expect(await store.deleteConnection(conn.id)).toBe(true);
    expect(await store.getConnection(conn.id)).toBeUndefined();
    expect(await store.deleteConnection(conn.id)).toBe(false);
  });

  test(`${name}: secret blob put/get/delete round-trip`, async () => {
    const store = make();
    const blob = secretBlob("conn_abcdef0123456789");
    await store.putSecretBlob(blob);

    expect(await store.getSecretBlob(blob.connectionId)).toEqual(blob);
    expect(await store.deleteSecretBlob(blob.connectionId)).toBe(true);
    expect(await store.getSecretBlob(blob.connectionId)).toBeUndefined();
    expect(await store.deleteSecretBlob(blob.connectionId)).toBe(false);
  });

  test(`${name}: listConnections excludes secret material entirely`, async () => {
    const store = make();
    const conn = connection();
    await store.putConnection(conn);
    await store.putSecretBlob(secretBlob(conn.id));

    const listed = await store.listConnections("space_1");
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("Y2lwaGVydGV4dA==");
  });

  test(`${name}: activity event put/list newest-first + space-scoped + limit`, async () => {
    const store = make();
    await store.putActivityEvent(activityEvent({
      id: "act_a",
      createdAt: "2026-06-06T00:00:01.000Z",
    }));
    await store.putActivityEvent(activityEvent({
      id: "act_b",
      action: "run.applied",
      targetType: "run",
      targetId: "apply_1",
      runId: "apply_1",
      metadata: { deploymentId: "dep_1" },
      createdAt: "2026-06-06T00:00:02.000Z",
    }));
    await store.putActivityEvent(activityEvent({
      id: "act_other",
      spaceId: "space_2",
      createdAt: "2026-06-06T00:00:03.000Z",
    }));

    const listed = await store.listActivityEvents("space_1");
    expect(listed.map((e) => e.id)).toEqual(["act_b", "act_a"]);
    expect(listed[0]!.runId).toBe("apply_1");
    expect(listed[0]!.metadata.deploymentId).toBe("dep_1");

    expect((await store.listActivityEvents("space_2")).map((e) => e.id))
      .toEqual(["act_other"]);
    expect((await store.listActivityEvents("space_1", { limit: 1 })).map((e) =>
      e.id
    )).toEqual(["act_b"]);
  });
}

function activityEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "act_default",
    spaceId: "space_1",
    actorId: "user_1",
    action: "installation.created",
    targetType: "installation",
    targetId: "inst_1",
    metadata: { name: "shop" },
    createdAt: "2026-06-06T00:00:00.000Z",
    ...overrides,
  };
}
