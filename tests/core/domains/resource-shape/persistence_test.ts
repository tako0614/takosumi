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
import {
  collectResourceFormPinBackupEntries,
  formatResourceShapeId,
} from "../../../../core/domains/resource-shape/mod.ts";
import type {
  ResolutionLockRecord,
  ResourceShapeRecord,
  SpacePolicyRecord,
  TargetPoolRecord,
} from "../../../../core/domains/resource-shape/records.ts";
import type { SpaceId } from "../../../../core/shared/ids.ts";
import type { IsoTimestamp } from "../../../../core/shared/time.ts";
import type { InstalledFormReference } from "takosumi-contract";

const SPACE_A = "sp_alpha" as SpaceId;
const SPACE_B = "sp_beta" as SpaceId;
const T0 = "2026-06-29T00:00:00.000Z" as IsoTimestamp;
const T1 = "2026-06-29T01:00:00.000Z" as IsoTimestamp;
const T2 = "2026-06-29T02:00:00.000Z" as IsoTimestamp;
const EXACT_FORM: InstalledFormReference = {
  formRef: {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ObjectBucket",
    definitionVersion: "1.0.0",
    schemaDigest: `sha256:${"1".repeat(64)}`,
  },
  packageDigest: `sha256:${"2".repeat(64)}`,
};

function readyShape(
  spaceId: SpaceId,
  name: string,
  createdAt: IsoTimestamp,
): ResourceShapeRecord {
  return {
    id: formatResourceShapeId(spaceId, "EdgeWorker", name),
    spaceId,
    kind: "EdgeWorker",
    name,
    managedBy: "api",
    spec: {},
    phase: "Ready",
    generation: 1,
    observedGeneration: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

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
    execution: {
      runId: "apply_resource_3",
      stateGeneration: 2,
      stateRef:
        "workspaces/sp_alpha/resources/tkrn_sp_alpha_ObjectBucket_assets/environments/prod/state-versions/00000002.tfstate.enc",
      stateDigest:
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      rawOutputRef:
        "workspaces/sp_alpha/resources/tkrn_sp_alpha_ObjectBucket_assets/runs/apply_resource_3/outputs.raw.json.enc",
      updatedAt: T1,
    },
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

function applyingShape(name: string, generation = 1): ResourceShapeRecord {
  return {
    ...minimalShape(),
    id: formatResourceShapeId(SPACE_A, "EdgeWorker", name),
    name,
    phase: "Applying",
    generation,
    updatedAt: T1,
  };
}

function fullLock(resourceId: string): ResolutionLockRecord {
  return {
    resourceId,
    selectedImplementation: "cloudflare_r2_bucket",
    targetPool: "default",
    target: "tgt_cf",
    targetSnapshot: {
      name: "tgt_cf",
      type: "cloudflare",
      ref: "cf_account",
      credentialRef: "conn_cf",
      priority: 100,
      implementations: [
        {
          shape: "ObjectBucket",
          implementation: "cloudflare_r2_bucket",
          plugin: "object-plugin",
          options: { revision: 3 },
          interfaces: { object_store: "native", s3_api: "native" },
        },
      ],
    },
    implementationSnapshot: {
      shape: "ObjectBucket",
      implementation: "cloudflare_r2_bucket",
      plugin: "object-plugin",
      options: { revision: 3 },
      interfaces: { object_store: "native", s3_api: "native" },
    },
    selectedImplementationPlugin: "object-plugin",
    selectedImplementationOptions: { revision: 3 },
    implementationFingerprint: "resolution-v2:{pinned}",
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
      await db
        .prepare(
          `insert into service_form_packages
             (package_digest, status, record_json, installed_at, updated_at)
           values (?, 'installed', '{}', ?, ?)`,
        )
        .bind(EXACT_FORM.packageDigest, T0, T0)
        .run();
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
      await client.query(
        `insert into takosumi_service_form_packages
           (package_digest, status, record_json, installed_at, updated_at)
         values ($1, 'installed', '{}'::jsonb, $2, $2)`,
        [EXACT_FORM.packageDigest, T0],
      );
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

    test("exact Form identity round-trips with its matching ResolutionLock", async () => {
      const record: ResourceShapeRecord = {
        ...fullShape(),
        id: formatResourceShapeId(
          SPACE_A,
          "ObjectBucket",
          `exact-form-${backend.label}`,
        ),
        name: `exact-form-${backend.label}`,
        form: EXACT_FORM,
        phase: "Applying",
        updatedAt: T2,
      };
      const lock: ResolutionLockRecord = {
        ...fullLock(record.id),
        form: EXACT_FORM,
        nativeResources: fullLock(record.id).nativeResources?.map(
          (nativeResource) => ({ ...nativeResource, form: EXACT_FORM }),
        ),
        updatedAt: T2,
      };
      expect(
        await stores.beginApply({ applyingRecord: record, plannedLock: lock }),
      ).toEqual({ status: "begun", record, lock });
      expect(await stores.resources.get(record.id)).toEqual(record);
      expect(await stores.locks.get(record.id)).toEqual(lock);

      let mismatchError: unknown;
      try {
        await stores.beginApply({
          applyingRecord: {
            ...record,
            id: `${record.id}-mismatch`,
            name: `${record.name}-mismatch`,
          },
          plannedLock: {
            ...lock,
            resourceId: `${record.id}-mismatch`,
            form: {
              ...EXACT_FORM,
              packageDigest: `sha256:${"3".repeat(64)}`,
            },
          },
        });
      } catch (error) {
        mismatchError = error;
      }
      expect(String(mismatchError)).toContain(
        "does not pin the Resource form identity",
      );
      await stores.removeResource({
        resourceId: record.id,
        expected: {
          generation: record.generation,
          phase: record.phase,
          updatedAt: record.updatedAt,
        },
        expectedLock: lock,
      });
    });

    test("legacy exact Form pinning is bounded, atomic, and immutable", async () => {
      const record: ResourceShapeRecord = {
        ...fullShape(),
        id: formatResourceShapeId(
          SPACE_A,
          "ObjectBucket",
          `legacy-pin-${backend.label}`,
        ),
        name: `legacy-pin-${backend.label}`,
      };
      const lock: ResolutionLockRecord = {
        ...fullLock(record.id),
        updatedAt: record.updatedAt,
      };
      await stores.resources.upsert(record);
      await stores.locks.put(lock);

      const page = await stores.resources.listUnpinnedBySpaceKindPage(
        SPACE_A,
        "ObjectBucket",
        { limit: 100 },
      );
      expect(page.items.map((item) => item.id)).toContain(record.id);
      expect(
        await stores.pinExactFormIdentity({
          resourceId: record.id,
          form: EXACT_FORM,
          expectedResource: {
            generation: record.generation,
            phase: record.phase,
            updatedAt: record.updatedAt,
          },
          expectedLock: lock,
        }),
      ).toMatchObject({ status: "pinned" });
      expect((await stores.resources.get(record.id))?.form).toEqual(EXACT_FORM);
      expect((await stores.locks.get(record.id))?.form).toEqual(EXACT_FORM);
      expect((await stores.locks.get(record.id))?.nativeResources).toEqual([
        {
          type: "cloudflare.r2_bucket",
          id: "assets",
          form: EXACT_FORM,
        },
      ]);

      expect(
        await stores.pinExactFormIdentity({
          resourceId: record.id,
          form: EXACT_FORM,
          expectedResource: {
            generation: record.generation,
            phase: record.phase,
            updatedAt: record.updatedAt,
          },
          expectedLock: lock,
        }),
      ).toMatchObject({ status: "already_pinned" });
      expect(
        await stores.pinExactFormIdentity({
          resourceId: record.id,
          form: {
            ...EXACT_FORM,
            packageDigest: `sha256:${"9".repeat(64)}`,
          },
          expectedResource: {
            generation: record.generation,
            phase: record.phase,
            updatedAt: record.updatedAt,
          },
          expectedLock: lock,
        }),
      ).toMatchObject({ status: "conflict" });

      const collection = await collectResourceFormPinBackupEntries(
        stores,
        SPACE_A,
      );
      expect(collection.status).toBe("ready");
      if (collection.status !== "ready") throw new Error("unexpected pin tear");
      const backupEntry = collection.entries.find(
        (entry) => entry.resourceId === record.id,
      );
      expect(backupEntry).toEqual({
        resourceId: record.id,
        resourceScopeId: SPACE_A,
        kind: record.kind,
        identity: EXACT_FORM,
      });
      expect(JSON.stringify(backupEntry)).not.toContain("s3.example");

      // Restore replay starts from an existing legacy pair and reuses only the
      // exact redacted identity; it never asks a resolver for another value.
      await stores.resources.upsert(record);
      await stores.locks.put(lock);
      expect(
        await stores.pinExactFormIdentity({
          resourceId: record.id,
          form: backupEntry!.identity,
          expectedResource: {
            generation: record.generation,
            phase: record.phase,
            updatedAt: record.updatedAt,
          },
          expectedLock: lock,
        }),
      ).toMatchObject({ status: "pinned" });
      await stores.locks.delete(record.id);
      await stores.resources.delete(record.id);
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
      expect(read && "execution" in read).toBe(false);
      expect(read && "stateAdoption" in read).toBe(false);
      expect(read && "conditions" in read).toBe(false);
      expect(read && "labels" in read).toBe(false);
    });

    test("resource shape: bundled-kind inventory is globally bounded and cursorable", async () => {
      const edge = readyShape(SPACE_B, `inventory-edge-${backend.label}`, T1);
      const queue: ResourceShapeRecord = {
        ...readyShape(SPACE_A, `inventory-queue-${backend.label}`, T2),
        id: formatResourceShapeId(
          SPACE_A,
          "Queue",
          `inventory-queue-${backend.label}`,
        ),
        kind: "Queue",
      };
      const custom: ResourceShapeRecord = {
        ...readyShape(SPACE_A, `inventory-custom-${backend.label}`, T2),
        id: formatResourceShapeId(
          SPACE_A,
          "OperatorCustom",
          `inventory-custom-${backend.label}`,
        ),
        kind: "OperatorCustom",
      };
      await stores.resources.upsert(edge);
      await stores.resources.upsert(queue);
      await stores.resources.upsert(custom);

      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await stores.resources.listByKindsPage(
          ["EdgeWorker", "Queue"],
          { limit: 1, ...(cursor ? { cursor } : {}) },
        );
        expect(page.items).toHaveLength(1);
        expect(["EdgeWorker", "Queue"]).toContain(page.items[0]?.kind);
        ids.push(page.items[0]!.id);
        cursor = page.nextCursor;
      } while (cursor);

      expect(ids).toContain(edge.id);
      expect(ids).toContain(queue.id);
      expect(ids).not.toContain(custom.id);
      await stores.resources.delete(edge.id);
      await stores.resources.delete(queue.id);
      await stores.resources.delete(custom.id);
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

    test("resource shape: create atomically preserves the first owner", async () => {
      const record: ResourceShapeRecord = {
        ...minimalShape(),
        id: formatResourceShapeId(SPACE_A, "EdgeWorker", "created-once"),
        name: "created-once",
      };
      expect(await stores.resources.create(record)).toEqual({
        status: "created",
        record,
      });
      const competing: ResourceShapeRecord = {
        ...record,
        managedBy: "competing-import",
        updatedAt: T2,
      };
      expect(await stores.resources.create(competing)).toEqual({
        status: "conflict",
        record,
      });
      expect(await stores.resources.get(record.id)).toEqual(record);
      await stores.resources.delete(record.id);
    });

    test("resource shape: compareAndSet fences stale backend observations", async () => {
      const record: ResourceShapeRecord = {
        ...fullShape(),
        id: formatResourceShapeId(SPACE_A, "ObjectBucket", "assets-cas"),
        name: "assets-cas",
      };
      await stores.resources.upsert(record);
      const observed: ResourceShapeRecord = {
        ...record,
        conditions: [
          ...(record.conditions ?? []),
          {
            type: "Drifted",
            status: "false",
            reason: "BackendInSync",
            observedGeneration: record.generation,
          },
        ],
        updatedAt: T2,
      };
      expect(
        await stores.resources.compareAndSet(observed, {
          generation: record.generation,
          phase: record.phase,
          updatedAt: record.updatedAt,
        }),
      ).toEqual({ status: "updated", record: observed });

      const stale = await stores.resources.compareAndSet(
        { ...record, updatedAt: T2 },
        {
          generation: record.generation,
          phase: record.phase,
          updatedAt: record.updatedAt,
        },
      );
      expect(stale.status).toBe("conflict");
      expect(await stores.resources.get(record.id)).toEqual(observed);
      await stores.resources.delete(record.id);
    });

    test("atomic apply: create, final commit, and stale fence have backend parity", async () => {
      const applying = applyingShape(`atomic-create-${backend.label}`);
      const plannedLock: ResolutionLockRecord = {
        ...minimalLock(applying.id),
        locked: true,
        updatedAt: T1,
      };
      expect(
        await stores.beginApply({
          applyingRecord: applying,
          plannedLock,
        }),
      ).toEqual({ status: "begun", record: applying, lock: plannedLock });
      expect(await stores.resources.get(applying.id)).toEqual(applying);
      expect(await stores.locks.get(applying.id)).toEqual(plannedLock);

      const ready: ResourceShapeRecord = {
        ...applying,
        phase: "Ready",
        observedGeneration: applying.generation,
        outputs: { endpoint: "https://atomic.example" },
        updatedAt: T2,
      };
      const finalLock: ResolutionLockRecord = {
        ...plannedLock,
        nativeResources: [{ type: "edge.worker", id: applying.name }],
        updatedAt: T2,
      };
      const expectedApplying = {
        generation: applying.generation,
        phase: "Applying" as const,
        updatedAt: applying.updatedAt,
      };
      expect(
        await stores.commitApply({
          readyRecord: ready,
          finalLock,
          expectedApplying,
        }),
      ).toEqual({ status: "committed", record: ready, lock: finalLock });
      expect(await stores.resources.get(applying.id)).toEqual(ready);
      expect(await stores.locks.get(applying.id)).toEqual(finalLock);

      const staleFinalLock: ResolutionLockRecord = {
        ...finalLock,
        nativeResources: [{ type: "edge.worker", id: "stale" }],
      };
      expect(
        await stores.commitApply({
          readyRecord: ready,
          finalLock: staleFinalLock,
          expectedApplying,
        }),
      ).toEqual({ status: "conflict", record: ready });
      expect(await stores.resources.get(applying.id)).toEqual(ready);
      expect(await stores.locks.get(applying.id)).toEqual(finalLock);

      await stores.locks.delete(applying.id);
      await stores.resources.delete(applying.id);
    });

    test("atomic apply: CAS begin distinguishes conflict and not_found without changing the lock", async () => {
      const current: ResourceShapeRecord = {
        ...readyShape(SPACE_A, `atomic-cas-${backend.label}`, T0),
        generation: 2,
        observedGeneration: 2,
      };
      const oldLock: ResolutionLockRecord = {
        ...minimalLock(current.id),
        selectedImplementation: "old_implementation",
      };
      await stores.resources.upsert(current);
      await stores.locks.put(oldLock);

      const applying: ResourceShapeRecord = {
        ...current,
        phase: "Applying",
        generation: 3,
        updatedAt: T1,
      };
      const plannedLock: ResolutionLockRecord = {
        ...oldLock,
        selectedImplementation: "new_implementation",
        updatedAt: T1,
      };
      const expected = {
        generation: current.generation,
        phase: current.phase,
        updatedAt: current.updatedAt,
      };
      expect(
        await stores.beginApply({
          applyingRecord: applying,
          plannedLock,
          expected,
        }),
      ).toEqual({ status: "begun", record: applying, lock: plannedLock });

      const competingLock: ResolutionLockRecord = {
        ...plannedLock,
        selectedImplementation: "must_not_publish",
      };
      expect(
        await stores.beginApply({
          applyingRecord: applying,
          plannedLock: competingLock,
          expected,
        }),
      ).toEqual({ status: "conflict", record: applying });
      expect(await stores.locks.get(current.id)).toEqual(plannedLock);

      const missing = applyingShape(`atomic-missing-${backend.label}`);
      expect(
        await stores.beginApply({
          applyingRecord: missing,
          plannedLock: minimalLock(missing.id),
          expected: {
            generation: 1,
            phase: "Ready",
            updatedAt: T0,
          },
        }),
      ).toEqual({ status: "not_found" });
      expect(await stores.locks.get(missing.id)).toBeUndefined();

      await stores.locks.delete(current.id);
      await stores.resources.delete(current.id);
    });

    test("atomic apply: CAS begin rejects a managedBy takeover without changing Resource or lock", async () => {
      const current = readyShape(SPACE_A, `atomic-owner-${backend.label}`, T0);
      const currentLock = minimalLock(current.id);
      await stores.resources.upsert(current);
      await stores.locks.put(currentLock);
      const takeover: ResourceShapeRecord = {
        ...current,
        managedBy: "compat.example.v1",
        phase: "Applying",
        generation: current.generation + 1,
        updatedAt: T1,
      };
      const takeoverLock = {
        ...currentLock,
        selectedImplementation: "must_not_publish",
        updatedAt: T1,
      };

      expect(
        await stores.beginApply({
          applyingRecord: takeover,
          plannedLock: takeoverLock,
          expected: {
            generation: current.generation,
            phase: current.phase,
            updatedAt: current.updatedAt,
          },
        }),
      ).toEqual({ status: "ownership_conflict", record: current });
      expect(await stores.resources.get(current.id)).toEqual(current);
      expect(await stores.locks.get(current.id)).toEqual(currentLock);

      await stores.locks.delete(current.id);
      await stores.resources.delete(current.id);
    });

    test("atomic apply: create-only race reports a managedBy takeover without changing the winner", async () => {
      const winner = readyShape(
        SPACE_A,
        `atomic-create-owner-${backend.label}`,
        T0,
      );
      const winnerLock = minimalLock(winner.id);
      await stores.resources.upsert(winner);
      await stores.locks.put(winnerLock);
      const loser: ResourceShapeRecord = {
        ...winner,
        managedBy: "compat.example.v1",
        phase: "Applying",
        updatedAt: T1,
      };
      const loserLock = {
        ...winnerLock,
        selectedImplementation: "must_not_publish",
        updatedAt: T1,
      };

      expect(
        await stores.beginApply({
          applyingRecord: loser,
          plannedLock: loserLock,
        }),
      ).toEqual({ status: "ownership_conflict", record: winner });
      expect(await stores.resources.get(winner.id)).toEqual(winner);
      expect(await stores.locks.get(winner.id)).toEqual(winnerLock);

      await stores.locks.delete(winner.id);
      await stores.resources.delete(winner.id);
    });

    test("atomic apply: abort restores prior Resource and lock or removes a create claim", async () => {
      const prior: ResourceShapeRecord = {
        ...readyShape(SPACE_A, `atomic-abort-${backend.label}`, T0),
        generation: 2,
        observedGeneration: 2,
      };
      const priorLock: ResolutionLockRecord = {
        ...minimalLock(prior.id),
        selectedImplementation: "prior_implementation",
      };
      await stores.resources.upsert(prior);
      await stores.locks.put(priorLock);
      const applying: ResourceShapeRecord = {
        ...prior,
        phase: "Applying",
        generation: 3,
        updatedAt: T1,
      };
      const plannedLock: ResolutionLockRecord = {
        ...priorLock,
        selectedImplementation: "planned_implementation",
        locked: true,
        updatedAt: T1,
      };
      await stores.beginApply({
        applyingRecord: applying,
        plannedLock,
        expected: {
          generation: prior.generation,
          phase: prior.phase,
          updatedAt: prior.updatedAt,
        },
      });
      expect(
        await stores.abortApply({
          resourceId: applying.id,
          expectedApplying: {
            generation: applying.generation,
            phase: "Applying",
            updatedAt: applying.updatedAt,
          },
          expectedPlannedLock: plannedLock,
          replacement: { record: prior, lock: priorLock },
        }),
      ).toEqual({ status: "rolled_back" });
      expect(await stores.resources.get(prior.id)).toEqual(prior);
      expect(await stores.locks.get(prior.id)).toEqual(priorLock);

      const created = applyingShape(`atomic-abort-create-${backend.label}`);
      const createdLock: ResolutionLockRecord = {
        ...minimalLock(created.id),
        locked: true,
        updatedAt: created.updatedAt,
      };
      await stores.beginApply({
        applyingRecord: created,
        plannedLock: createdLock,
      });
      expect(
        await stores.abortApply({
          resourceId: created.id,
          expectedApplying: {
            generation: created.generation,
            phase: "Applying",
            updatedAt: created.updatedAt,
          },
          expectedPlannedLock: createdLock,
          replacement: null,
        }),
      ).toEqual({ status: "rolled_back" });
      expect(await stores.resources.get(created.id)).toBeUndefined();
      expect(await stores.locks.get(created.id)).toBeUndefined();

      await stores.locks.delete(prior.id);
      await stores.resources.delete(prior.id);
    });

    test("atomic apply: abort fences the planned lock and supports a known-failure replacement", async () => {
      const prior = readyShape(SPACE_A, `atomic-fail-${backend.label}`, T0);
      await stores.resources.upsert(prior);
      const applying: ResourceShapeRecord = {
        ...prior,
        phase: "Applying",
        generation: 2,
        updatedAt: T1,
      };
      const plannedLock: ResolutionLockRecord = {
        ...minimalLock(applying.id),
        selectedImplementation: "planned_implementation",
        locked: true,
        updatedAt: T1,
      };
      await stores.beginApply({
        applyingRecord: applying,
        plannedLock,
        expected: {
          generation: prior.generation,
          phase: prior.phase,
          updatedAt: prior.updatedAt,
        },
      });
      const competingLock: ResolutionLockRecord = {
        ...plannedLock,
        selectedImplementation: "next_apply_implementation",
        updatedAt: T2,
      };
      await stores.locks.put(competingLock);
      const failed: ResourceShapeRecord = {
        ...applying,
        phase: "Failed",
        conditions: [
          {
            type: "Ready",
            status: "false",
            reason: "KnownNoMutation",
            observedGeneration: applying.generation,
          },
        ],
        updatedAt: T2,
      };
      const conflict = await stores.abortApply({
        resourceId: applying.id,
        expectedApplying: {
          generation: applying.generation,
          phase: "Applying",
          updatedAt: applying.updatedAt,
        },
        expectedPlannedLock: plannedLock,
        replacement: { record: failed, lock: null },
      });
      expect(conflict.status).toBe("conflict");
      expect(await stores.resources.get(applying.id)).toEqual(applying);
      expect(await stores.locks.get(applying.id)).toEqual(competingLock);

      await stores.locks.put(plannedLock);
      expect(
        await stores.abortApply({
          resourceId: applying.id,
          expectedApplying: {
            generation: applying.generation,
            phase: "Applying",
            updatedAt: applying.updatedAt,
          },
          expectedPlannedLock: plannedLock,
          replacement: { record: failed, lock: null },
        }),
      ).toEqual({ status: "rolled_back" });
      expect(await stores.resources.get(applying.id)).toEqual(failed);
      expect(await stores.locks.get(applying.id)).toBeUndefined();
      await stores.resources.delete(applying.id);
    });

    test("atomic remove fences the exact Resource and ResolutionLock pair", async () => {
      const record: ResourceShapeRecord = {
        ...fullShape(),
        id: formatResourceShapeId(
          SPACE_A,
          "ObjectBucket",
          `atomic-remove-${backend.label}`,
        ),
        name: `atomic-remove-${backend.label}`,
        phase: "Deleting",
        updatedAt: T2,
      };
      const lock = fullLock(record.id);
      await stores.resources.upsert(record);
      await stores.locks.put(lock);

      const staleResource = await stores.removeResource({
        resourceId: record.id,
        expected: {
          generation: record.generation,
          phase: record.phase,
          updatedAt: T1,
        },
        expectedLock: lock,
      });
      expect(staleResource.status).toBe("conflict");
      expect(await stores.resources.get(record.id)).toEqual(record);
      expect(await stores.locks.get(record.id)).toEqual(lock);

      const competingLock: ResolutionLockRecord = {
        ...lock,
        selectedImplementation: "competing_implementation",
        updatedAt: T2,
      };
      await stores.locks.put(competingLock);
      const staleLock = await stores.removeResource({
        resourceId: record.id,
        expected: {
          generation: record.generation,
          phase: record.phase,
          updatedAt: record.updatedAt,
        },
        expectedLock: lock,
      });
      expect(staleLock.status).toBe("conflict");
      expect(await stores.resources.get(record.id)).toEqual(record);
      expect(await stores.locks.get(record.id)).toEqual(competingLock);

      expect(
        await stores.removeResource({
          resourceId: record.id,
          expected: {
            generation: record.generation,
            phase: record.phase,
            updatedAt: record.updatedAt,
          },
          expectedLock: competingLock,
        }),
      ).toEqual({ status: "removed" });
      expect(await stores.resources.get(record.id)).toBeUndefined();
      expect(await stores.locks.get(record.id)).toBeUndefined();
      expect(
        await stores.removeResource({
          resourceId: record.id,
          expected: {
            generation: record.generation,
            phase: record.phase,
            updatedAt: record.updatedAt,
          },
          expectedLock: competingLock,
        }),
      ).toEqual({ status: "not_found" });

      const unlocked: ResourceShapeRecord = {
        ...record,
        id: formatResourceShapeId(
          SPACE_A,
          "ObjectBucket",
          `atomic-remove-unlocked-${backend.label}`,
        ),
        name: `atomic-remove-unlocked-${backend.label}`,
      };
      await stores.resources.upsert(unlocked);
      expect(
        await stores.removeResource({
          resourceId: unlocked.id,
          expected: {
            generation: unlocked.generation,
            phase: unlocked.phase,
            updatedAt: unlocked.updatedAt,
          },
          expectedLock: null,
        }),
      ).toEqual({ status: "removed" });
    });

    test("resource shape: claimDelete atomically marks one active deleter", async () => {
      const record: ResourceShapeRecord = {
        ...fullShape(),
        id: formatResourceShapeId(SPACE_A, "ObjectBucket", "assets-claim"),
        name: "assets-claim",
      };
      await stores.resources.upsert(record);
      const deleting: ResourceShapeRecord = {
        ...record,
        phase: "Deleting",
        conditions: [
          {
            type: "Ready",
            status: "false",
            reason: "Deleting",
            observedGeneration: record.generation,
          },
        ],
        updatedAt: T2,
      };

      const claimed = await stores.resources.claimDelete(
        deleting,
        record.generation,
        record.managedBy,
      );
      expect(claimed).toEqual({ status: "claimed", record: deleting });
      expect(await stores.resources.get(record.id)).toEqual(deleting);

      const duplicate = await stores.resources.claimDelete(
        deleting,
        record.generation,
        record.managedBy,
      );
      expect(duplicate).toEqual({
        status: "already_deleting",
        record: deleting,
      });

      const missing = await stores.resources.claimDelete(
        {
          ...deleting,
          id: formatResourceShapeId(SPACE_A, "ObjectBucket", "missing"),
        },
        record.generation,
        record.managedBy,
      );
      expect(missing).toEqual({ status: "not_found" });
      await stores.resources.delete(record.id);
    });

    test("resource shape: claimDelete detects generation conflicts", async () => {
      const record: ResourceShapeRecord = {
        ...fullShape(),
        id: formatResourceShapeId(SPACE_A, "ObjectBucket", "assets-conflict"),
        name: "assets-conflict",
      };
      await stores.resources.upsert(record);
      const deleting: ResourceShapeRecord = {
        ...record,
        phase: "Deleting",
        updatedAt: T2,
      };
      const conflict = await stores.resources.claimDelete(
        deleting,
        999,
        record.managedBy,
      );
      expect(conflict).toEqual({ status: "conflict", record });
      expect(await stores.resources.get(record.id)).toEqual(record);
      await stores.resources.delete(record.id);
    });

    test("resource shape: claimDelete rejects a managedBy takeover atomically", async () => {
      const record: ResourceShapeRecord = {
        ...fullShape(),
        id: formatResourceShapeId(SPACE_A, "ObjectBucket", "owner-delete"),
        name: "owner-delete",
      };
      await stores.resources.upsert(record);
      const deleting: ResourceShapeRecord = {
        ...record,
        phase: "Deleting",
        updatedAt: T2,
      };

      expect(
        await stores.resources.claimDelete(
          deleting,
          record.generation,
          "compat.example.v1",
        ),
      ).toEqual({ status: "ownership_conflict", record });
      expect(await stores.resources.get(record.id)).toEqual(record);
      await stores.resources.delete(record.id);
    });

    test("resource shape: observation claims are fair, fenced, and reclaim stale leases", async () => {
      const oldest = readyShape(
        SPACE_B,
        "observation-oldest",
        "2026-06-28T00:00:00.000Z" as IsoTimestamp,
      );
      const next = readyShape(
        SPACE_A,
        "observation-next",
        "2026-06-28T01:00:00.000Z" as IsoTimestamp,
      );
      const pending: ResourceShapeRecord = {
        ...readyShape(
          SPACE_A,
          "observation-pending",
          "2026-06-27T00:00:00.000Z" as IsoTimestamp,
        ),
        phase: "Pending",
      };
      const staleGeneration: ResourceShapeRecord = {
        ...readyShape(
          SPACE_A,
          "observation-stale-generation",
          "2026-06-27T01:00:00.000Z" as IsoTimestamp,
        ),
        generation: 2,
        observedGeneration: 1,
      };
      const records = [oldest, next, pending, staleGeneration] as const;
      for (const record of records) await stores.resources.upsert(record);

      const claimedAt = "2026-07-01T02:00:00.000Z";
      const dueBefore = "2026-07-01T01:00:00.000Z";
      const staleClaimBefore = "2026-07-01T01:00:00.000Z";
      const first = await stores.resources.claimObservationCandidate({
        leaseId: "lease-first",
        claimedAt,
        dueBefore,
        staleClaimBefore,
      });
      expect(first?.id).toBe(oldest.id);

      const second = await stores.resources.claimObservationCandidate({
        leaseId: "lease-second",
        claimedAt,
        dueBefore,
        staleClaimBefore,
      });
      expect(second?.id).toBe(next.id);
      expect(
        await stores.resources.claimObservationCandidate({
          leaseId: "lease-none",
          claimedAt,
          dueBefore,
          staleClaimBefore,
        }),
      ).toBeUndefined();

      expect(
        await stores.resources.finishObservationClaim(
          oldest.id,
          "lease-wrong",
          "2026-07-01T02:30:00.000Z",
        ),
      ).toBe(false);
      expect(
        await stores.resources.finishObservationClaim(
          oldest.id,
          "lease-first",
          "2026-07-01T02:30:00.000Z",
        ),
      ).toBe(true);

      const reclaimed = await stores.resources.claimObservationCandidate({
        leaseId: "lease-reclaimed",
        claimedAt: "2026-07-01T04:00:00.000Z",
        dueBefore: "2026-07-01T03:00:00.000Z",
        staleClaimBefore: "2026-07-01T03:00:00.000Z",
      });
      expect(reclaimed?.id).toBe(next.id);
      expect(
        await stores.resources.finishObservationClaim(
          next.id,
          "lease-second",
          "2026-07-01T04:30:00.000Z",
        ),
      ).toBe(false);
      expect(
        await stores.resources.finishObservationClaim(
          next.id,
          "lease-reclaimed",
          "2026-07-01T04:30:00.000Z",
        ),
      ).toBe(true);

      expect(
        await stores.resources.claimObservationCandidate({
          leaseId: "lease-too-soon",
          claimedAt: "2026-07-01T05:00:00.000Z",
          dueBefore: "2026-07-01T02:00:00.000Z",
          staleClaimBefore: "2026-07-01T04:00:00.000Z",
        }),
      ).toBeUndefined();

      for (const record of records) await stores.resources.delete(record.id);
    });

    test("resource shape: concurrent observation claims select distinct Resources", async () => {
      const records = Array.from({ length: 4 }, (_, index) =>
        readyShape(
          index % 2 === 0 ? SPACE_A : SPACE_B,
          `observation-concurrent-${index}`,
          `2026-06-28T0${index}:00:00.000Z` as IsoTimestamp,
        ),
      );
      for (const record of records) await stores.resources.upsert(record);

      const claims = await Promise.all(
        records.map((_, index) =>
          stores.resources.claimObservationCandidate({
            leaseId: `lease-concurrent-${index}`,
            claimedAt: "2026-07-02T02:00:00.000Z",
            dueBefore: "2026-07-02T01:00:00.000Z",
            staleClaimBefore: "2026-07-02T01:00:00.000Z",
          }),
        ),
      );
      const claimedIds = claims.map((claim) => claim?.id);
      expect(claimedIds.every(Boolean)).toBe(true);
      expect(new Set(claimedIds).size).toBe(records.length);

      await Promise.all(
        claims.map((claim, index) =>
          stores.resources.finishObservationClaim(
            claim!.id,
            `lease-concurrent-${index}`,
            "2026-07-02T02:30:00.000Z",
          ),
        ),
      );
      for (const record of records) await stores.resources.delete(record.id);
    });

    test("resource shape: state adoption confirmation is fenced and round-trips", async () => {
      const record: ResourceShapeRecord = {
        ...minimalShape(),
        id: formatResourceShapeId(SPACE_A, "EdgeWorker", "adoption"),
        name: "adoption",
      };
      await stores.resources.upsert(record);
      const descriptor = {
        kind: "legacy_backing_capsule_state" as const,
        sourceWorkspaceId: SPACE_A,
        sourceCapsuleId: "cap_legacy_adoption",
        sourceEnvironment: "resource-shape",
        sourceStateVersionId: "state_legacy_3",
        stateGeneration: 3,
        stateRef:
          "spaces/sp_alpha/installations/cap_legacy_adoption/envs/resource-shape/states/00000003.tfstate.enc",
        stateDigest: `sha256:${"a".repeat(64)}`,
        confirmedBy: "operator_1",
        confirmedAt: T1,
      };
      const confirmed = await stores.resources.confirmStateAdoption(
        record.id,
        descriptor,
        record.updatedAt,
      );
      expect(confirmed.status).toBe("confirmed");
      expect((await stores.resources.get(record.id))?.stateAdoption).toEqual(
        descriptor,
      );

      const duplicate = await stores.resources.confirmStateAdoption(
        record.id,
        descriptor,
        record.updatedAt,
      );
      expect(duplicate.status).toBe("conflict");
      await stores.resources.delete(record.id);
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

      const firstPage = await stores.resources.listBySpacePage(SPACE_A, {
        limit: 1,
      });
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.nextCursor).toBeDefined();
      const secondPage = await stores.resources.listBySpacePage(SPACE_A, {
        limit: 1,
        cursor: firstPage.nextCursor!,
      });
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.nextCursor).toBeUndefined();
      expect(
        [...firstPage.items, ...secondPage.items].map((r) => r.id).sort(),
      ).toEqual([a1.id, a2.id].sort());

      await stores.resources.delete(a2.id);
      expect(await stores.resources.get(a2.id)).toBeUndefined();
      expect(
        (await stores.resources.listBySpace(SPACE_A)).map((r) => r.id),
      ).not.toContain(a2.id);
    });

    test("resource shape: Ready kind inventory is global, coherent, and keyset paged", async () => {
      const records: readonly ResourceShapeRecord[] = [
        readyShape(SPACE_B, "inventory-a", T0),
        readyShape(SPACE_A, "inventory-b", T0),
        readyShape(SPACE_A, "inventory-c", T1),
        {
          ...readyShape(SPACE_A, "inventory-unobserved", T0),
          observedGeneration: 0,
        },
        {
          ...readyShape(SPACE_A, "inventory-pending", T0),
          phase: "Pending",
          observedGeneration: 0,
        },
        {
          ...fullShape(),
          id: formatResourceShapeId(
            SPACE_B,
            "ObjectBucket",
            "inventory-bucket",
          ),
          spaceId: SPACE_B,
          name: "inventory-bucket",
          generation: 2,
          observedGeneration: 2,
          createdAt: T0,
          updatedAt: T0,
        },
      ];
      for (const resource of records) await stores.resources.upsert(resource);

      const expected = records
        .filter(
          (resource) =>
            resource.kind === "EdgeWorker" &&
            resource.phase === "Ready" &&
            resource.observedGeneration === resource.generation,
        )
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id),
        );
      const observed: ResourceShapeRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await stores.resources.listReadyByKindPage("EdgeWorker", {
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        observed.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);

      expect(
        observed
          .filter(({ name }) => name.startsWith("inventory-"))
          .map(({ id }) => id),
      ).toEqual(expected.map(({ id }) => id));
      expect(
        await stores.resources.listReadyByKindPage("InventoryAbsentKind", {
          limit: 10,
        }),
      ).toEqual({ items: [] });

      for (const resource of records)
        await stores.resources.delete(resource.id);
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

      const firstPage = await stores.targetPools.listBySpacePage(SPACE_A, {
        limit: 1,
      });
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.nextCursor).toBeDefined();
      const secondPage = await stores.targetPools.listBySpacePage(SPACE_A, {
        limit: 1,
        cursor: firstPage.nextCursor!,
      });
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.nextCursor).toBeUndefined();
      expect(
        [...firstPage.items, ...secondPage.items].map((r) => r.id).sort(),
      ).toEqual([p1.id, p2.id].sort());

      await stores.targetPools.delete(p1.id);
      expect(await stores.targetPools.get(p1.id)).toBeUndefined();
    });

    test("target pool: create is atomic and preserves the durable winner", async () => {
      const winner = targetPool(`create-only-${backend.label}`);
      expect(await stores.targetPools.create(winner)).toEqual({
        status: "created",
        record: winner,
      });
      const contender: TargetPoolRecord = {
        ...winner,
        spec: { targets: [{ target: "must-not-win", rank: 999 }] },
        updatedAt: T2,
      };
      expect(await stores.targetPools.create(contender)).toEqual({
        status: "conflict",
        record: winner,
      });
      expect(await stores.targetPools.get(winner.id)).toEqual(winner);
      await stores.targetPools.delete(winner.id);
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

      const firstPage = await stores.spacePolicies.listBySpacePage(SPACE_A, {
        limit: 1,
      });
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.nextCursor).toBeDefined();
      const secondPage = await stores.spacePolicies.listBySpacePage(SPACE_A, {
        limit: 1,
        cursor: firstPage.nextCursor!,
      });
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.nextCursor).toBeUndefined();
      expect(
        [...firstPage.items, ...secondPage.items].map((r) => r.id).sort(),
      ).toEqual([s1.id, s2.id].sort());

      await stores.spacePolicies.delete(s2.id);
      expect(await stores.spacePolicies.get(s2.id)).toBeUndefined();
      expect(
        await stores.spacePolicies.getByName(SPACE_A, "strict"),
      ).toBeUndefined();
    });
  });
}

test("D1 atomic apply batch rolls back both Resource and ResolutionLock writes", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const stores = createD1ResourceShapeStores(db);
  await db
    .prepare(
      `create trigger force_atomic_lock_failure
       before insert on resolution_locks
       when new.selected_implementation = 'forced_failure'
       begin
         select raise(abort, 'forced atomic lock failure');
       end`,
    )
    .run();

  const applying = applyingShape("atomic-rollback-d1");
  const failingLock: ResolutionLockRecord = {
    ...minimalLock(applying.id),
    selectedImplementation: "forced_failure",
  };
  await expect(
    stores.beginApply({ applyingRecord: applying, plannedLock: failingLock }),
  ).rejects.toThrow("forced atomic lock failure");
  expect(await stores.resources.get(applying.id)).toBeUndefined();
  expect(await stores.locks.get(applying.id)).toBeUndefined();

  const plannedLock: ResolutionLockRecord = {
    ...failingLock,
    selectedImplementation: "working_implementation",
  };
  await stores.beginApply({ applyingRecord: applying, plannedLock });
  const ready: ResourceShapeRecord = {
    ...applying,
    phase: "Ready",
    observedGeneration: applying.generation,
    updatedAt: T2,
  };
  await expect(
    stores.commitApply({
      readyRecord: ready,
      finalLock: failingLock,
      expectedApplying: {
        generation: applying.generation,
        phase: "Applying",
        updatedAt: applying.updatedAt,
      },
    }),
  ).rejects.toThrow("forced atomic lock failure");
  expect(await stores.resources.get(applying.id)).toEqual(applying);
  expect(await stores.locks.get(applying.id)).toEqual(plannedLock);

  const failedReplacement: ResourceShapeRecord = {
    ...applying,
    phase: "Failed",
    updatedAt: T2,
  };
  await expect(
    stores.abortApply({
      resourceId: applying.id,
      expectedApplying: {
        generation: applying.generation,
        phase: "Applying",
        updatedAt: applying.updatedAt,
      },
      expectedPlannedLock: plannedLock,
      replacement: { record: failedReplacement, lock: failingLock },
    }),
  ).rejects.toThrow("forced atomic lock failure");
  expect(await stores.resources.get(applying.id)).toEqual(applying);
  expect(await stores.locks.get(applying.id)).toEqual(plannedLock);
});

test("Postgres atomic apply transaction rolls back both Resource and ResolutionLock writes", async () => {
  const client = await PGliteSqlClient.create();
  try {
    await client.exec(
      `alter table takosumi_resolution_locks
       add constraint force_atomic_lock_failure
       check (selected_implementation <> 'forced_failure')`,
    );
    const stores = createSqlResourceShapeStores(client);
    const applying = applyingShape("atomic-rollback-postgres");
    const failingLock: ResolutionLockRecord = {
      ...minimalLock(applying.id),
      selectedImplementation: "forced_failure",
    };
    await expect(
      stores.beginApply({ applyingRecord: applying, plannedLock: failingLock }),
    ).rejects.toThrow("force_atomic_lock_failure");
    expect(await stores.resources.get(applying.id)).toBeUndefined();
    expect(await stores.locks.get(applying.id)).toBeUndefined();

    const plannedLock: ResolutionLockRecord = {
      ...failingLock,
      selectedImplementation: "working_implementation",
    };
    await stores.beginApply({ applyingRecord: applying, plannedLock });
    const ready: ResourceShapeRecord = {
      ...applying,
      phase: "Ready",
      observedGeneration: applying.generation,
      updatedAt: T2,
    };
    await expect(
      stores.commitApply({
        readyRecord: ready,
        finalLock: failingLock,
        expectedApplying: {
          generation: applying.generation,
          phase: "Applying",
          updatedAt: applying.updatedAt,
        },
      }),
    ).rejects.toThrow("force_atomic_lock_failure");
    expect(await stores.resources.get(applying.id)).toEqual(applying);
    expect(await stores.locks.get(applying.id)).toEqual(plannedLock);

    const failedReplacement: ResourceShapeRecord = {
      ...applying,
      phase: "Failed",
      updatedAt: T2,
    };
    await expect(
      stores.abortApply({
        resourceId: applying.id,
        expectedApplying: {
          generation: applying.generation,
          phase: "Applying",
          updatedAt: applying.updatedAt,
        },
        expectedPlannedLock: plannedLock,
        replacement: { record: failedReplacement, lock: failingLock },
      }),
    ).rejects.toThrow("force_atomic_lock_failure");
    expect(await stores.resources.get(applying.id)).toEqual(applying);
    expect(await stores.locks.get(applying.id)).toEqual(plannedLock);
  } finally {
    await client.close();
  }
});

test("D1 exact Form pin batch rolls back both Resource and ResolutionLock writes", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  await db
    .prepare(
      `insert into service_form_packages
         (package_digest, status, record_json, installed_at, updated_at)
       values (?, 'installed', '{}', ?, ?)`,
    )
    .bind(EXACT_FORM.packageDigest, T0, T0)
    .run();
  const stores = createD1ResourceShapeStores(db);
  const record: ResourceShapeRecord = {
    ...fullShape(),
    id: formatResourceShapeId(SPACE_A, "ObjectBucket", "form-pin-rollback-d1"),
    name: "form-pin-rollback-d1",
  };
  const lock = { ...fullLock(record.id), updatedAt: record.updatedAt };
  await stores.resources.upsert(record);
  await stores.locks.put(lock);
  await db
    .prepare(
      `create trigger force_form_pin_lock_failure
       before update on resolution_locks
       when new.package_digest = '${EXACT_FORM.packageDigest}'
       begin
         select raise(abort, 'forced exact Form pin failure');
       end`,
    )
    .run();

  await expect(
    stores.pinExactFormIdentity({
      resourceId: record.id,
      form: EXACT_FORM,
      expectedResource: {
        generation: record.generation,
        phase: record.phase,
        updatedAt: record.updatedAt,
      },
      expectedLock: lock,
    }),
  ).rejects.toThrow("forced exact Form pin failure");
  expect(await stores.resources.get(record.id)).toEqual(record);
  expect(await stores.locks.get(record.id)).toEqual(lock);
});

test("Postgres exact Form pin transaction rolls back both Resource and ResolutionLock writes", async () => {
  const client = await PGliteSqlClient.create();
  try {
    await client.query(
      `insert into takosumi_service_form_packages
         (package_digest, status, record_json, installed_at, updated_at)
       values ($1, 'installed', '{}'::jsonb, $2, $2)`,
      [EXACT_FORM.packageDigest, T0],
    );
    const stores = createSqlResourceShapeStores(client);
    const record: ResourceShapeRecord = {
      ...fullShape(),
      id: formatResourceShapeId(
        SPACE_A,
        "ObjectBucket",
        "form-pin-rollback-postgres",
      ),
      name: "form-pin-rollback-postgres",
    };
    const lock = { ...fullLock(record.id), updatedAt: record.updatedAt };
    await stores.resources.upsert(record);
    await stores.locks.put(lock);
    await client.exec(
      `alter table takosumi_resolution_locks
       add constraint force_form_pin_lock_failure
       check (package_digest <> '${EXACT_FORM.packageDigest}')`,
    );

    await expect(
      stores.pinExactFormIdentity({
        resourceId: record.id,
        form: EXACT_FORM,
        expectedResource: {
          generation: record.generation,
          phase: record.phase,
          updatedAt: record.updatedAt,
        },
        expectedLock: lock,
      }),
    ).rejects.toThrow("force_form_pin_lock_failure");
    expect(await stores.resources.get(record.id)).toEqual(record);
    expect(await stores.locks.get(record.id)).toEqual(lock);
  } finally {
    await client.close();
  }
});

test("D1 atomic remove batch rolls back both Resource and ResolutionLock deletes", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const stores = createD1ResourceShapeStores(db);
  const record: ResourceShapeRecord = {
    ...readyShape(SPACE_A, "atomic-remove-rollback-d1", T0),
    phase: "Deleting",
    updatedAt: T2,
  };
  const lock = minimalLock(record.id);
  await stores.resources.upsert(record);
  await stores.locks.put(lock);
  await db
    .prepare(
      `create trigger force_atomic_resource_delete_failure
       before delete on resource_shapes
       when old.id = '${record.id}'
       begin
         select raise(abort, 'forced atomic resource delete failure');
       end`,
    )
    .run();

  await expect(
    stores.removeResource({
      resourceId: record.id,
      expected: {
        generation: record.generation,
        phase: record.phase,
        updatedAt: record.updatedAt,
      },
      expectedLock: lock,
    }),
  ).rejects.toThrow("forced atomic resource delete failure");
  expect(await stores.resources.get(record.id)).toEqual(record);
  expect(await stores.locks.get(record.id)).toEqual(lock);

  await db.prepare("drop trigger force_atomic_resource_delete_failure").run();
  expect(
    await stores.removeResource({
      resourceId: record.id,
      expected: {
        generation: record.generation,
        phase: record.phase,
        updatedAt: record.updatedAt,
      },
      expectedLock: lock,
    }),
  ).toEqual({ status: "removed" });
});

test("Postgres atomic remove transaction rolls back both Resource and ResolutionLock deletes", async () => {
  const client = await PGliteSqlClient.create();
  try {
    const stores = createSqlResourceShapeStores(client);
    const record: ResourceShapeRecord = {
      ...readyShape(SPACE_A, "atomic-remove-rollback-postgres", T0),
      phase: "Deleting",
      updatedAt: T2,
    };
    const lock = minimalLock(record.id);
    await stores.resources.upsert(record);
    await stores.locks.put(lock);
    await client.query(
      `create table force_atomic_resource_delete_guard (
        resource_id text primary key references takosumi_resource_shapes(id)
      )`,
    );
    await client.query(
      "insert into force_atomic_resource_delete_guard (resource_id) values ($1)",
      [record.id],
    );

    await expect(
      stores.removeResource({
        resourceId: record.id,
        expected: {
          generation: record.generation,
          phase: record.phase,
          updatedAt: record.updatedAt,
        },
        expectedLock: lock,
      }),
    ).rejects.toThrow();
    expect(await stores.resources.get(record.id)).toEqual(record);
    expect(await stores.locks.get(record.id)).toEqual(lock);

    await client.query(
      "delete from force_atomic_resource_delete_guard where resource_id = $1",
      [record.id],
    );
    expect(
      await stores.removeResource({
        resourceId: record.id,
        expected: {
          generation: record.generation,
          phase: record.phase,
          updatedAt: record.updatedAt,
        },
        expectedLock: lock,
      }),
    ).toEqual({ status: "removed" });
  } finally {
    await client.close();
  }
});

test("D1 persistence retains registered-shape tokens and rejects malformed tokens", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const stores = createD1ResourceShapeStores(db);
  const record: ResourceShapeRecord = {
    ...minimalShape(),
    id: "tkrn:sp_alpha:EdgeWorker:corrupt-d1",
    name: "corrupt-d1",
  };
  await stores.resources.upsert(record);
  await db
    .prepare("update resource_shapes set kind = ? where id = ?")
    .bind("CacheCluster", record.id)
    .run();

  expect((await stores.resources.get(record.id))?.kind).toBe("CacheCluster");
  await db
    .prepare("update resource_shapes set kind = ? where id = ?")
    .bind("Cache Cluster", record.id)
    .run();
  await expect(stores.resources.get(record.id)).rejects.toThrow(
    "invalid Resource Shape kind token: Cache Cluster",
  );
});

test("Postgres persistence retains registered-shape tokens and rejects malformed tokens", async () => {
  const client = await PGliteSqlClient.create();
  try {
    const stores = createSqlResourceShapeStores(client);
    const record: ResourceShapeRecord = {
      ...minimalShape(),
      id: "tkrn:sp_alpha:EdgeWorker:corrupt-pg",
      name: "corrupt-pg",
    };
    await stores.resources.upsert(record);
    await client.query(
      "update takosumi_resource_shapes set kind = $1 where id = $2",
      ["CacheCluster", record.id],
    );

    expect((await stores.resources.get(record.id))?.kind).toBe("CacheCluster");
    await client.query(
      "update takosumi_resource_shapes set kind = $1 where id = $2",
      ["Cache Cluster", record.id],
    );
    await expect(stores.resources.get(record.id)).rejects.toThrow(
      "invalid Resource Shape kind token: Cache Cluster",
    );
  } finally {
    await client.close();
  }
});
