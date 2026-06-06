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
}
