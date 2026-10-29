import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
  type StoredSecretBlob,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(30_000);
const clients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const client = await PGliteSqlClient.create();
  clients.push(client);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

const now = "2026-10-28T00:00:00.000Z";
const later = "2026-10-28T00:01:00.000Z";
function connection(id: string): ProviderConnection {
  return {
    id, scope: "personal", ownerAccountId: "owner", provider: "registry.opentofu.org/example/service",
    providerSource: "registry.opentofu.org/example/service", secretPartition: "provider-credentials",
    status: "pending", materialization: "secret", envNames: ["SERVICE_TOKEN"],
    createdAt: now, updatedAt: now,
  };
}

function blob(row: ProviderConnection): StoredSecretBlob {
  return {
    id: `blob_${row.id}`, connectionId: row.id, kind: "provider-credentials",
    ciphertext: "ZmFrZQ==", encryptedDek: "fixture-dek", nonce: "ZmFrZQ==",
    aad: JSON.stringify({ ownerAccountId: row.ownerAccountId, connectionId: row.id, provider: row.provider }),
    keyVersion: 3, createdAt: now,
  };
}

test("workspace-less personal Connection registration, test, expiry, and revoke use exact owner CAS", async () => {
  for (const [label, store] of await stores()) {
    const row = connection(`conn_personal_${label}`);
    const material = blob(row);
    expect(await store.createConnectionRegistration({ connection: row, secretBlob: material, actorAuthority: null }), label)
      .toBe(true);
    expect(await store.getConnection(row.id), label).toEqual(row);
    expect(await store.getSecretBlob(row.id), label).toEqual(material);
    expect(await store.createConnectionRegistration({
      connection: { ...row, ownerAccountId: "other" }, secretBlob: material, actorAuthority: null,
    }), label).toBe(false);
    await expect(store.createConnectionRegistration({
      connection: { ...row, id: `${row.id}_missing_owner`, ownerAccountId: undefined }, actorAuthority: null,
    }), label).rejects.toThrow(/requires an owner/);
    await expect(store.createConnectionRegistration({
      connection: { ...row, id: `${row.id}_workspace`, workspaceId: "ws" }, actorAuthority: null,
    }), label).rejects.toThrow(/no Workspace authority/);

    const tested: ProviderConnection = { ...row, status: "verified", verifiedAt: later, updatedAt: later };
    await expect(store.commitConnectionTestResult({ expectedConnection: row, expectedSecretBlob: material,
      replacement: { ...tested, ownerAccountId: "other" }, actorAuthority: null }), label)
      .rejects.toThrow(/cannot replace identity/);
    expect(await store.commitConnectionTestResult({
      expectedConnection: { ...row, ownerAccountId: "other" }, expectedSecretBlob: material,
      replacement: { ...tested, ownerAccountId: "other" }, actorAuthority: null,
    }), label).toBe(false);
    expect(await store.commitConnectionTestResult({
      expectedConnection: row, expectedSecretBlob: material, replacement: tested, actorAuthority: null,
    }), label).toBe(true);
    expect(await store.replaceConnectionIfUnchanged(tested, { ...tested, ownerAccountId: "other" }), label).toBe(false);
    expect(await store.revokeConnectionIfUnchanged({ expectedConnection: { ...tested, ownerAccountId: "other" },
      actorAuthority: null }), label).toBe(false);
    expect(await store.getSecretBlob(row.id), label).toEqual(material);

    const expiring: ProviderConnection = { ...tested, expiresAt: now };
    await store.putConnection(expiring);
    expect(await store.markConnectionExpiredIfUnchanged({ expectedConnection: { ...expiring, ownerAccountId: "other" },
      observedAt: later }), label).toBe(false);
    expect(await store.markConnectionExpiredIfUnchanged({ expectedConnection: expiring,
      observedAt: later }), label).toBe(true);
    const expired = (await store.getConnection(row.id))!;
    expect(expired.status, label).toBe("expired");
    expect(expired.ownerAccountId, label).toBe("owner");
    expect(await store.revokeConnectionIfUnchanged({ expectedConnection: expired, actorAuthority: null }), label)
      .toBe(true);
    expect(await store.getConnection(row.id), label).toBeUndefined();
    expect(await store.getSecretBlob(row.id), label).toBeUndefined();
  }
});
