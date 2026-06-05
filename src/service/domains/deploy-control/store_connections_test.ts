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
import { CloudflareD1OpenTofuDeploymentStore } from "../../../../deploy/cloudflare/src/d1_opentofu_store.ts";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../../../deploy/cloudflare/src/bindings.ts";
import type { Connection } from "takosumi-contract/deploy-control-api";

// -- Minimal D1 fake for the takosumi_cf_opentofu_ledger namespace table -------

interface LedgerRow {
  namespace: string;
  key: string;
  space_id: string | null;
  installation_id: string | null;
  status: string | null;
  record_json: string;
  created_at: number;
  updated_at: number;
}

class FakeLedgerD1 implements D1Database {
  readonly rows = new Map<string, LedgerRow>();

  prepare(query: string): D1PreparedStatement {
    return new FakeLedgerStatement(this, query);
  }
}

class FakeLedgerStatement implements D1PreparedStatement {
  #bound: readonly unknown[] = [];

  constructor(
    private readonly db: FakeLedgerD1,
    private readonly query: string,
  ) {}

  bind(...values: readonly unknown[]): D1PreparedStatement {
    this.#bound = values;
    return this;
  }

  first<T = unknown>(): Promise<T | null> {
    const q = normalize(this.query);
    if (q.startsWith("select record_json from") && q.includes("where namespace = ? and key = ?")) {
      const [namespace, key] = this.#bound as [string, string];
      const row = this.db.rows.get(rowKey(namespace, key));
      return Promise.resolve(row ? ({ record_json: row.record_json } as T) : null);
    }
    return Promise.resolve(null);
  }

  all<T = unknown>(): Promise<D1Result<T>> {
    const q = normalize(this.query);
    if (q.startsWith("select record_json from") && q.includes("space_id = ?")) {
      const [namespace, spaceId] = this.#bound as [string, string];
      const matched = [...this.db.rows.values()]
        .filter((row) => row.namespace === namespace && row.space_id === spaceId)
        .sort((a, b) => a.created_at - b.created_at || a.key.localeCompare(b.key))
        .map((row) => ({ record_json: row.record_json }) as T);
      return Promise.resolve({ results: matched, success: true });
    }
    return Promise.resolve({ results: [], success: true });
  }

  run<T = unknown>(): Promise<D1Result<T>> {
    const q = normalize(this.query);
    if (q.startsWith("create table") || q.startsWith("create index")) {
      return Promise.resolve({ success: true, meta: { changes: 0 } });
    }
    if (q.startsWith("insert into")) {
      const [
        namespace,
        key,
        space_id,
        installation_id,
        status,
        record_json,
        created_at,
        updated_at,
      ] = this.#bound as [
        string,
        string,
        string | null,
        string | null,
        string | null,
        string,
        number,
        number,
      ];
      this.db.rows.set(rowKey(namespace, key), {
        namespace,
        key,
        space_id,
        installation_id,
        status,
        record_json,
        created_at,
        updated_at,
      });
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (q.startsWith("delete from")) {
      const [namespace, key] = this.#bound as [string, string];
      const existed = this.db.rows.delete(rowKey(namespace, key));
      return Promise.resolve({ success: true, meta: { changes: existed ? 1 : 0 } });
    }
    return Promise.resolve({ success: true, meta: { changes: 0 } });
  }
}

function rowKey(namespace: string, key: string): string {
  return `${namespace}\0${key}`;
}

function normalize(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

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
  ["d1", () => new CloudflareD1OpenTofuDeploymentStore(new FakeLedgerD1())],
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
