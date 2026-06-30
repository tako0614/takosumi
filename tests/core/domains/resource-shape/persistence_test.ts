// Durable persistence conformance for the Resource Shape stores.
//
// One shared suite runs against the in-memory reference impl AND the two
// durable backends (Cloudflare D1 via bun:sqlite, Postgres via PGlite), so the
// row<->record mapping + JSON (de)serialization of every entity is exercised in
// both directions (record -> row on write, row -> record on read) on the real
// SQL the stores emit.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { createD1ResourceShapeStores } from "../../../../core/domains/resource-shape/d1_stores.ts";
import { createSqlResourceShapeStores } from "../../../../core/domains/resource-shape/sql_stores.ts";
import { createInMemoryResourceShapeStores } from "../../../../core/domains/resource-shape/stores.ts";
import type { ResourceShapeStores } from "../../../../core/domains/resource-shape/stores.ts";
import { formatResourceShapeId } from "../../../../core/domains/resource-shape/records.ts";
import type {
  ResolutionLockRecord,
  ResourceShapeRecord,
  SpacePolicyRecord,
  TargetPoolRecord,
} from "../../../../core/domains/resource-shape/records.ts";
import type { SpaceId } from "../../../../core/shared/ids.ts";
import type { IsoTimestamp } from "../../../../core/shared/time.ts";

const SPACE_A = "sp_alpha" as SpaceId;
const SPACE_B = "sp_beta" as SpaceId;
const T0 = "2026-06-29T00:00:00.000Z" as IsoTimestamp;
const T1 = "2026-06-29T01:00:00.000Z" as IsoTimestamp;

function fullShape(): ResourceShapeRecord {
  return {
    id: formatResourceShapeId(SPACE_A, "ObjectBucket", "assets"),
    spaceId: SPACE_A,
    project: "web",
    environment: "prod",
    kind: "ObjectBucket",
    name: "assets",
    managedBy: "opentofu",
    spec: {
      name: "assets",
      interfaces: ["s3_api"],
      nested: { a: [1, 2, 3] },
    },
    phase: "Ready",
    generation: 3,
    observedGeneration: 2,
    outputs: { bucket_name: "assets", s3_endpoint: "https://s3.example" },
    conditions: [
      {
        type: "Ready",
        status: "true",
        reason: "Applied",
        observedGeneration: 2,
      },
    ],
    labels: { team: "platform", tier: "gold" },
    createdAt: T0,
    updatedAt: T1,
  };
}

function minimalShape(): ResourceShapeRecord {
  return {
    id: formatResourceShapeId(SPACE_A, "EdgeWorker", "api"),
    spaceId: SPACE_A,
    kind: "EdgeWorker",
    name: "api",
    managedBy: "api",
    spec: {},
    phase: "Pending",
    generation: 1,
    observedGeneration: 0,
    createdAt: T0,
    updatedAt: T0,
  };
}

function fullLock(resourceId: string): ResolutionLockRecord {
  return {
    resourceId,
    selectedImplementation: "cloudflare_r2_bucket",
    target: "tgt_cf",
    locked: true,
    reason: ["best capability score", "operator preference"],
    portability: "mostly_portable",
    nativeResources: [{ type: "cloudflare.r2_bucket", id: "assets" }],
    lockedAt: T0,
    updatedAt: T1,
  };
}

function minimalLock(resourceId: string): ResolutionLockRecord {
  return {
    resourceId,
    selectedImplementation: "cloudflare_workers",
    target: "tgt_aws",
    locked: false,
    reason: [],
    lockedAt: T0,
    updatedAt: T0,
  };
}

function targetPool(name: string, spaceId = SPACE_A): TargetPoolRecord {
  return {
    id: `tpool_${spaceId}_${name}`,
    spaceId,
    name,
    spec: { targets: [{ target: "tgt_cf", rank: 1 }] },
    createdAt: T0,
    updatedAt: T1,
  };
}

function spacePolicy(name: string, spaceId = SPACE_A): SpacePolicyRecord {
  return {
    id: `spol_${spaceId}_${name}`,
    spaceId,
    name,
    spec: { allowedTargets: ["tgt_cf"], denyEgress: true },
    createdAt: T0,
    updatedAt: T1,
  };
}

interface Backend {
  readonly label: string;
  setup(): Promise<{
    readonly stores: ResourceShapeStores;
    readonly teardown: () => Promise<void>;
  }>;
}

const backends: readonly Backend[] = [
  {
    label: "in-memory",
    setup() {
      return Promise.resolve({
        stores: createInMemoryResourceShapeStores(),
        teardown: () => Promise.resolve(),
      });
    },
  },
  {
    label: "cloudflare-d1",
    async setup() {
      const db = new SqliteFakeD1();
      await ensureD1OpenTofuLedgerSchema(db);
      return {
        stores: createD1ResourceShapeStores(db),
        teardown: () => Promise.resolve(),
      };
    },
  },
  {
    label: "postgres",
    async setup() {
      const client = await PGliteSqlClient.create();
      return {
        stores: createSqlResourceShapeStores(client),
        teardown: () => client.close(),
      };
    },
  },
];

for (const backend of backends) {
  describe(`Resource Shape persistence (${backend.label})`, () => {
    let stores: ResourceShapeStores;
    let teardown: () => Promise<void>;

    beforeAll(async () => {
      const ctx = await backend.setup();
      stores = ctx.stores;
      teardown = ctx.teardown;
    });

    afterAll(async () => {
      await teardown();
    });

    test("resource shape: full record round-trips by id and name", async () => {
      const record = fullShape();
      expect(await stores.resources.upsert(record)).toEqual(record);
      expect(await stores.resources.get(record.id)).toEqual(record);
      expect(
        await stores.resources.getByName(SPACE_A, "ObjectBucket", "assets"),
      ).toEqual(record);
    });

    test("resource shape: minimal record omits absent optionals", async () => {
      const record = minimalShape();
      await stores.resources.upsert(record);
      const read = await stores.resources.get(record.id);
      expect(read).toEqual(record);
      // Optional columns must not resurface as keys.
      expect(read && "project" in read).toBe(false);
      expect(read && "environment" in read).toBe(false);
      expect(read && "outputs" in read).toBe(false);
      expect(read && "conditions" in read).toBe(false);
      expect(read && "labels" in read).toBe(false);
    });

    test("resource shape: upsert overwrites on id conflict", async () => {
      const record = fullShape();
      await stores.resources.upsert(record);
      const updated: ResourceShapeRecord = {
        ...record,
        phase: "Degraded",
        generation: 4,
        observedGeneration: 4,
        outputs: { endpoint: "https://assets-2.example" },
        updatedAt: "2026-06-29T02:00:00.000Z" as IsoTimestamp,
      };
      await stores.resources.upsert(updated);
      expect(await stores.resources.get(record.id)).toEqual(updated);
      // Still exactly one row for the (space, kind, name) tuple.
      const listed = (await stores.resources.listBySpace(SPACE_A)).filter(
        (r) => r.id === record.id,
      );
      expect(listed).toHaveLength(1);
    });

    test("resource shape: listBySpace is space-scoped + delete removes", async () => {
      const a1 = fullShape();
      const a2 = minimalShape();
      const b1: ResourceShapeRecord = {
        ...minimalShape(),
        id: formatResourceShapeId(SPACE_B, "EdgeWorker", "api"),
        spaceId: SPACE_B,
      };
      await stores.resources.upsert(a1);
      await stores.resources.upsert(a2);
      await stores.resources.upsert(b1);

      const inA = await stores.resources.listBySpace(SPACE_A);
      expect(inA.map((r) => r.id).sort()).toEqual([a1.id, a2.id].sort());
      const inB = await stores.resources.listBySpace(SPACE_B);
      expect(inB.map((r) => r.id)).toEqual([b1.id]);

      await stores.resources.delete(a2.id);
      expect(await stores.resources.get(a2.id)).toBeUndefined();
      expect(
        (await stores.resources.listBySpace(SPACE_A)).map((r) => r.id),
      ).not.toContain(a2.id);
    });

    test("resource shape: get/getByName miss returns undefined", async () => {
      expect(
        await stores.resources.get("tkrn:nope:ObjectBucket:x"),
      ).toBeUndefined();
      expect(
        await stores.resources.getByName(SPACE_A, "Machine", "absent"),
      ).toBeUndefined();
    });

    test("resolution lock: full + minimal round-trip and overwrite", async () => {
      const resourceId = formatResourceShapeId(SPACE_A, "ObjectBucket", "lk");
      const full = fullLock(resourceId);
      expect(await stores.locks.put(full)).toEqual(full);
      expect(await stores.locks.get(resourceId)).toEqual(full);

      const min = minimalLock(resourceId);
      await stores.locks.put(min);
      const read = await stores.locks.get(resourceId);
      expect(read).toEqual(min);
      expect(read && "portability" in read).toBe(false);
      expect(read && "nativeResources" in read).toBe(false);
      expect(read?.locked).toBe(false);

      await stores.locks.delete(resourceId);
      expect(await stores.locks.get(resourceId)).toBeUndefined();
    });

    test("target pool: round-trip, getByName, space scope, delete", async () => {
      const p1 = targetPool("primary");
      const p2 = targetPool("fallback");
      const pb = targetPool("primary", SPACE_B);
      await stores.targetPools.upsert(p1);
      await stores.targetPools.upsert(p2);
      await stores.targetPools.upsert(pb);

      expect(await stores.targetPools.get(p1.id)).toEqual(p1);
      expect(await stores.targetPools.getByName(SPACE_A, "primary")).toEqual(
        p1,
      );
      expect(await stores.targetPools.getByName(SPACE_B, "primary")).toEqual(
        pb,
      );
      expect(
        (await stores.targetPools.listBySpace(SPACE_A)).map((r) => r.id).sort(),
      ).toEqual([p1.id, p2.id].sort());

      await stores.targetPools.delete(p1.id);
      expect(await stores.targetPools.get(p1.id)).toBeUndefined();
    });

    test("space policy: round-trip, getByName, space scope, delete", async () => {
      const s1 = spacePolicy("default");
      const s2 = spacePolicy("strict");
      const sb = spacePolicy("default", SPACE_B);
      await stores.spacePolicies.upsert(s1);
      await stores.spacePolicies.upsert(s2);
      await stores.spacePolicies.upsert(sb);

      expect(await stores.spacePolicies.get(s1.id)).toEqual(s1);
      expect(await stores.spacePolicies.getByName(SPACE_A, "default")).toEqual(
        s1,
      );
      expect(
        (await stores.spacePolicies.listBySpace(SPACE_A))
          .map((r) => r.id)
          .sort(),
      ).toEqual([s1.id, s2.id].sort());

      await stores.spacePolicies.delete(s2.id);
      expect(await stores.spacePolicies.get(s2.id)).toBeUndefined();
      expect(
        await stores.spacePolicies.getByName(SPACE_A, "strict"),
      ).toBeUndefined();
    });
  });
}
