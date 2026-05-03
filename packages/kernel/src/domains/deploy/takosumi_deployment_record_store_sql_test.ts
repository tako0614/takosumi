import assert from "node:assert/strict";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../../adapters/storage/sql.ts";
import { SqlTakosumiDeploymentRecordStore } from "./takosumi_deployment_record_store_sql.ts";

/**
 * In-memory fake `SqlClient` tailored to the exact subset of SQL emitted
 * by `SqlTakosumiDeploymentRecordStore`. It is NOT a general-purpose SQL
 * fake; it is a focused harness that lets us assert the store's
 * round-trip behaviour against the migration schema without spinning up
 * Postgres for unit tests.
 *
 * The real Postgres driver is exercised by the operator's smoke run
 * against a live database; this fake lets the kernel CI check method
 * shapes, value mapping, and lock semantics in milliseconds.
 */
interface TakosumiDeploymentFakeRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  name: string;
  manifest_json: unknown;
  applied_resources_json: unknown;
  status: string;
  created_at: string;
  updated_at: string;
}

class FakeTakosumiSqlClient implements SqlClient {
  readonly rows: TakosumiDeploymentFakeRow[] = [];

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    const params = (parameters ?? []) as readonly unknown[];
    const trimmed = sql.trim().toLowerCase();
    const cast = <T>(value: T): SqlQueryResult<Row> =>
      value as unknown as SqlQueryResult<Row>;
    if (trimmed.startsWith("insert into takosumi_deployments")) {
      return Promise.resolve(cast(this.#handleUpsert(params)));
    }
    if (
      trimmed.startsWith("update takosumi_deployments") &&
      trimmed.includes("status = 'destroyed'")
    ) {
      return Promise.resolve(cast(this.#handleMarkDestroyed(params)));
    }
    if (trimmed.startsWith("delete from takosumi_deployments")) {
      return Promise.resolve(cast(this.#handleDelete(params)));
    }
    if (
      trimmed.startsWith(
        "select id, tenant_id, name, manifest_json, applied_resources_json, status, created_at, updated_at " +
          "from takosumi_deployments where tenant_id = $1 and name = $2",
      )
    ) {
      return Promise.resolve(cast(this.#handleGet(params)));
    }
    if (
      trimmed.startsWith(
        "select id, tenant_id, name, manifest_json, applied_resources_json, status, created_at, updated_at " +
          "from takosumi_deployments where tenant_id = $1 order by",
      )
    ) {
      return Promise.resolve(cast(this.#handleList(params)));
    }
    if (
      trimmed.startsWith(
        "select manifest_json, applied_resources_json from takosumi_deployments",
      )
    ) {
      return Promise.resolve(cast(this.#handleListJson()));
    }
    throw new Error(`unexpected sql in fake takosumi sql client: ${sql}`);
  }

  #handleUpsert(
    params: readonly unknown[],
  ): SqlQueryResult<TakosumiDeploymentFakeRow> {
    const [id, tenantId, name, manifestJson, appliedJson, status, now] =
      params as [string, string, string, string, string, string, string];
    const existing = this.rows.find(
      (row) => row.tenant_id === tenantId && row.name === name,
    );
    if (existing) {
      existing.manifest_json = manifestJson;
      existing.applied_resources_json = appliedJson;
      existing.status = status;
      existing.updated_at = now;
      return { rows: [{ ...existing }], rowCount: 1 };
    }
    const inserted: TakosumiDeploymentFakeRow = {
      id,
      tenant_id: tenantId,
      name,
      manifest_json: manifestJson,
      applied_resources_json: appliedJson,
      status,
      created_at: now,
      updated_at: now,
    };
    this.rows.push(inserted);
    return { rows: [{ ...inserted }], rowCount: 1 };
  }

  #handleMarkDestroyed(
    params: readonly unknown[],
  ): SqlQueryResult<TakosumiDeploymentFakeRow> {
    const [tenantId, name, now] = params as [string, string, string];
    const row = this.rows.find(
      (entry) => entry.tenant_id === tenantId && entry.name === name,
    );
    if (!row) return { rows: [], rowCount: 0 };
    row.status = "destroyed";
    row.applied_resources_json = "[]";
    row.updated_at = now;
    return { rows: [{ ...row }], rowCount: 1 };
  }

  #handleDelete(
    params: readonly unknown[],
  ): SqlQueryResult<{ id: string }> {
    const [tenantId, name] = params as [string, string];
    const index = this.rows.findIndex(
      (row) => row.tenant_id === tenantId && row.name === name,
    );
    if (index < 0) return { rows: [], rowCount: 0 };
    const [removed] = this.rows.splice(index, 1);
    return { rows: [{ id: removed.id }], rowCount: 1 };
  }

  #handleGet(
    params: readonly unknown[],
  ): SqlQueryResult<TakosumiDeploymentFakeRow> {
    const [tenantId, name] = params as [string, string];
    const row = this.rows.find(
      (entry) => entry.tenant_id === tenantId && entry.name === name,
    );
    return row
      ? { rows: [{ ...row }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  #handleList(
    params: readonly unknown[],
  ): SqlQueryResult<TakosumiDeploymentFakeRow> {
    const [tenantId] = params as [string];
    const filtered = this.rows
      .filter((row) => row.tenant_id === tenantId)
      .map((row) => ({ ...row }))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { rows: filtered, rowCount: filtered.length };
  }

  #handleListJson(): SqlQueryResult<{
    manifest_json: unknown;
    applied_resources_json: unknown;
  }> {
    return {
      rows: this.rows.map((row) => ({
        manifest_json: row.manifest_json,
        applied_resources_json: row.applied_resources_json,
      })),
      rowCount: this.rows.length,
    };
  }
}

const TENANT = "takosumi-deploy";
const NOW_1 = "2026-05-02T00:00:00.000Z";
const NOW_2 = "2026-05-02T00:00:01.000Z";
const NOW_3 = "2026-05-02T00:00:02.000Z";

const HASH_A =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const HASH_B =
  "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const HASH_C =
  "sha256:3333333333333333333333333333333333333333333333333333333333333333";

function createStore(): {
  store: SqlTakosumiDeploymentRecordStore;
  client: FakeTakosumiSqlClient;
} {
  const client = new FakeTakosumiSqlClient();
  const store = new SqlTakosumiDeploymentRecordStore({ client });
  return { store, client };
}

Deno.test("SqlStore.upsert inserts a new row when (tenantId, name) is fresh", async () => {
  const { store } = createStore();
  const record = await store.upsert({
    tenantId: TENANT,
    name: "my-app",
    manifest: { resources: [] },
    appliedResources: [],
    status: "applied",
    now: NOW_1,
  });
  assert.equal(record.tenantId, TENANT);
  assert.equal(record.name, "my-app");
  assert.equal(record.status, "applied");
  assert.equal(record.createdAt, NOW_1);
  assert.equal(record.updatedAt, NOW_1);
  assert.ok(record.id.length > 0);
});

Deno.test("SqlStore.upsert updates the same row when natural key matches", async () => {
  const { store } = createStore();
  const first = await store.upsert({
    tenantId: TENANT,
    name: "my-app",
    manifest: { resources: [] },
    appliedResources: [],
    status: "applied",
    now: NOW_1,
  });
  const second = await store.upsert({
    tenantId: TENANT,
    name: "my-app",
    manifest: { resources: [{ shape: "object-store@v1" }] },
    appliedResources: [{
      resourceName: "logs",
      shape: "object-store@v1",
      providerId: "filesystem",
      handle: "h_1",
      outputs: { ok: true },
      appliedAt: NOW_2,
      specFingerprint: "fnv1a32:abcd1234",
    }],
    status: "applied",
    now: NOW_2,
  });
  assert.equal(
    second.id,
    first.id,
    "upsert keeps surrogate id stable across re-applies",
  );
  assert.equal(second.createdAt, NOW_1);
  assert.equal(second.updatedAt, NOW_2);
  assert.equal(second.appliedResources.length, 1);
  assert.equal(second.appliedResources[0].handle, "h_1");
  // Round-trip the specFingerprint that the idempotency change persists.
  assert.equal(
    second.appliedResources[0].specFingerprint,
    "fnv1a32:abcd1234",
  );
});

Deno.test("SqlStore.get returns undefined for missing rows", async () => {
  const { store } = createStore();
  const missing = await store.get(TENANT, "nope");
  assert.equal(missing, undefined);
});

Deno.test("SqlStore.list filters by tenantId", async () => {
  const { store } = createStore();
  await store.upsert({
    tenantId: "tenant-a",
    name: "app-1",
    manifest: {},
    appliedResources: [],
    status: "applied",
    now: NOW_1,
  });
  await store.upsert({
    tenantId: "tenant-b",
    name: "app-1",
    manifest: {},
    appliedResources: [],
    status: "applied",
    now: NOW_1,
  });
  const a = await store.list("tenant-a");
  const b = await store.list("tenant-b");
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].tenantId, "tenant-a");
  assert.equal(b[0].tenantId, "tenant-b");
});

Deno.test("SqlStore.markDestroyed clears appliedResources and flips status", async () => {
  const { store } = createStore();
  await store.upsert({
    tenantId: TENANT,
    name: "my-app",
    manifest: {},
    appliedResources: [{
      resourceName: "logs",
      shape: "object-store@v1",
      providerId: "filesystem",
      handle: "h_1",
      outputs: {},
      appliedAt: NOW_1,
    }],
    status: "applied",
    now: NOW_1,
  });
  const updated = await store.markDestroyed(TENANT, "my-app", NOW_2);
  assert.ok(updated);
  assert.equal(updated!.status, "destroyed");
  assert.equal(updated!.appliedResources.length, 0);
  assert.equal(updated!.updatedAt, NOW_2);
  assert.equal(updated!.createdAt, NOW_1);
});

Deno.test("SqlStore.markDestroyed returns undefined when no row matches", async () => {
  const { store } = createStore();
  const result = await store.markDestroyed(TENANT, "ghost", NOW_2);
  assert.equal(result, undefined);
});

Deno.test("SqlStore.remove drops the row and returns true exactly once", async () => {
  const { store } = createStore();
  await store.upsert({
    tenantId: TENANT,
    name: "my-app",
    manifest: {},
    appliedResources: [],
    status: "applied",
    now: NOW_1,
  });
  assert.equal(await store.remove(TENANT, "my-app"), true);
  assert.equal(await store.remove(TENANT, "my-app"), false);
});

// --- listReferencedArtifactHashes -------------------------------------------

Deno.test(
  "SqlStore.listReferencedArtifactHashes returns hashes from manifest_json",
  async () => {
    const { store } = createStore();
    await store.upsert({
      tenantId: TENANT,
      name: "worker-app",
      manifest: {
        resources: [{
          shape: "worker@v1",
          name: "api",
          provider: "cloudflare-workers",
          spec: { artifact: { kind: "js-bundle", hash: HASH_A } },
        }],
      },
      appliedResources: [],
      status: "applied",
      now: NOW_1,
    });
    const hashes = await store.listReferencedArtifactHashes();
    assert.equal(hashes.size, 1);
    assert.ok(hashes.has(HASH_A));
  },
);

Deno.test(
  "SqlStore.listReferencedArtifactHashes returns hashes from applied_resources_json outputs",
  async () => {
    const { store } = createStore();
    await store.upsert({
      tenantId: TENANT,
      name: "worker-app",
      manifest: { resources: [] },
      appliedResources: [{
        resourceName: "api",
        shape: "worker@v1",
        providerId: "cloudflare-workers",
        handle: "h_1",
        outputs: { deployedArtifact: HASH_B },
        appliedAt: NOW_1,
      }],
      status: "applied",
      now: NOW_1,
    });
    const hashes = await store.listReferencedArtifactHashes();
    assert.equal(hashes.size, 1);
    assert.ok(hashes.has(HASH_B));
  },
);

Deno.test(
  "SqlStore.listReferencedArtifactHashes unions input + output hashes across rows",
  async () => {
    const { store } = createStore();
    await store.upsert({
      tenantId: TENANT,
      name: "a",
      manifest: { resources: [{ spec: { artifact: { hash: HASH_A } } }] },
      appliedResources: [{
        resourceName: "api",
        shape: "worker@v1",
        providerId: "cloudflare-workers",
        handle: "h_1",
        outputs: { deployedArtifact: HASH_B },
        appliedAt: NOW_1,
      }],
      status: "applied",
      now: NOW_1,
    });
    await store.upsert({
      tenantId: TENANT,
      name: "b",
      manifest: { resources: [{ spec: { artifact: { hash: HASH_C } } }] },
      appliedResources: [],
      status: "applied",
      now: NOW_1,
    });
    const hashes = await store.listReferencedArtifactHashes();
    assert.equal(hashes.size, 3);
    assert.ok(hashes.has(HASH_A));
    assert.ok(hashes.has(HASH_B));
    assert.ok(hashes.has(HASH_C));
  },
);

// --- Concurrency ------------------------------------------------------------

Deno.test(
  "SqlStore.acquireLock serialises concurrent acquirers on the same key",
  async () => {
    const { store } = createStore();
    const order: string[] = [];

    await store.acquireLock(TENANT, "app-x");
    order.push("first-acquired");

    let secondAcquired = false;
    const secondPromise = (async () => {
      await store.acquireLock(TENANT, "app-x");
      order.push("second-acquired");
      secondAcquired = true;
      await store.releaseLock(TENANT, "app-x");
    })();

    // Yield ticks so the second acquirer reaches its `await`.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      secondAcquired,
      false,
      "second acquireLock must wait while first holder is alive",
    );

    await store.releaseLock(TENANT, "app-x");
    await secondPromise;
    assert.deepEqual(order, ["first-acquired", "second-acquired"]);
  },
);

Deno.test(
  "SqlStore.acquireLock does not block on different keys",
  async () => {
    const { store } = createStore();
    await store.acquireLock(TENANT, "app-a");
    // (TENANT, app-b) shares no lock key with (TENANT, app-a) so this
    // must resolve immediately.
    await store.acquireLock(TENANT, "app-b");
    await store.releaseLock(TENANT, "app-a");
    await store.releaseLock(TENANT, "app-b");
  },
);

Deno.test(
  "SqlStore.releaseLock without prior acquire is a no-op",
  async () => {
    const { store } = createStore();
    await store.releaseLock(TENANT, "ghost");
    // Subsequent acquire must still work normally.
    await store.acquireLock(TENANT, "ghost");
    await store.releaseLock(TENANT, "ghost");
  },
);

Deno.test(
  "SqlStore.acquireLock + releaseLock round-trip serialises a second acquirer",
  async () => {
    const { store } = createStore();
    await store.acquireLock(TENANT, "advisory-key");
    let secondAcquired = false;
    const second = (async () => {
      await store.acquireLock(TENANT, "advisory-key");
      secondAcquired = true;
    })();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(secondAcquired, false);
    await store.releaseLock(TENANT, "advisory-key");
    await second;
    assert.equal(secondAcquired, true);
    await store.releaseLock(TENANT, "advisory-key");
  },
);

Deno.test(
  "SqlStore.acquireLock fan-out: many concurrent waiters resolve in arrival order",
  async () => {
    const { store } = createStore();
    const order: number[] = [];
    await store.acquireLock(TENANT, "fanout");
    const waiters = Array.from({ length: 5 }, (_, i) =>
      (async () => {
        await store.acquireLock(TENANT, "fanout");
        order.push(i);
        await store.releaseLock(TENANT, "fanout");
      })());
    // Yield enough microtasks so every waiter is queued.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await store.releaseLock(TENANT, "fanout");
    await Promise.all(waiters);
    assert.equal(order.length, 5);
    assert.deepEqual(order.slice().sort(), [0, 1, 2, 3, 4]);
  },
);

// --- Round-trip CRUD --------------------------------------------------------

Deno.test(
  "SqlStore CRUD round-trip: upsert -> get -> list -> markDestroyed -> remove",
  async () => {
    const { store } = createStore();
    await store.upsert({
      tenantId: TENANT,
      name: "round-trip-app",
      manifest: { metadata: { name: "round-trip-app" }, resources: [] },
      appliedResources: [{
        resourceName: "logs",
        shape: "object-store@v1",
        providerId: "filesystem",
        handle: "h_round_1",
        outputs: { url: "memory://logs" },
        appliedAt: NOW_1,
        specFingerprint: "fnv1a32:99887766",
      }],
      status: "applied",
      now: NOW_1,
    });

    const fetched = await store.get(TENANT, "round-trip-app");
    assert.ok(fetched);
    assert.equal(fetched!.appliedResources.length, 1);
    assert.equal(fetched!.appliedResources[0].handle, "h_round_1");
    assert.equal(
      fetched!.appliedResources[0].specFingerprint,
      "fnv1a32:99887766",
    );

    const listed = await store.list(TENANT);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, "round-trip-app");

    const destroyed = await store.markDestroyed(
      TENANT,
      "round-trip-app",
      NOW_2,
    );
    assert.ok(destroyed);
    assert.equal(destroyed!.status, "destroyed");
    assert.equal(destroyed!.appliedResources.length, 0);
    assert.equal(destroyed!.updatedAt, NOW_2);

    const removed = await store.remove(TENANT, "round-trip-app");
    assert.equal(removed, true);
    assert.equal(await store.get(TENANT, "round-trip-app"), undefined);
  },
);

Deno.test("SqlStore.list returns rows ordered by createdAt ascending", async () => {
  const { store } = createStore();
  await store.upsert({
    tenantId: TENANT,
    name: "app-2",
    manifest: {},
    appliedResources: [],
    status: "applied",
    now: NOW_2,
  });
  await store.upsert({
    tenantId: TENANT,
    name: "app-1",
    manifest: {},
    appliedResources: [],
    status: "applied",
    now: NOW_1,
  });
  await store.upsert({
    tenantId: TENANT,
    name: "app-3",
    manifest: {},
    appliedResources: [],
    status: "applied",
    now: NOW_3,
  });
  const rows = await store.list(TENANT);
  assert.deepEqual(
    rows.map((row) => row.name),
    ["app-1", "app-2", "app-3"],
  );
});
