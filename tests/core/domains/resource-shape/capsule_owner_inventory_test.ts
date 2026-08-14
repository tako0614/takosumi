import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type ResourceCapsuleOwner,
  type ResourcePhase,
} from "takosumi-contract";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { createD1ResourceShapeStores } from "../../../../core/domains/resource-shape/d1_stores.ts";
import {
  formatResourceShapeId,
  type ResolutionLockRecord,
} from "../../../../core/domains/resource-shape/records.ts";
import { createSqlResourceShapeStores } from "../../../../core/domains/resource-shape/sql_stores.ts";
import {
  createInMemoryResourceShapeStores,
  resourceRecordRevision,
  type ResourceShapeStores,
} from "../../../../core/domains/resource-shape/stores.ts";
import type { ResourceShapeRecord } from "../../../../core/domains/resource-shape/records.ts";
import type { SpaceId } from "../../../../core/shared/ids.ts";
import type { IsoTimestamp } from "../../../../core/shared/time.ts";

const SPACE = "sp_capsule_inventory" as SpaceId;
const OTHER_SPACE = "sp_other_inventory" as SpaceId;
const CAPSULE = "capsule_inventory";
const OTHER_CAPSULE = "capsule_other";
const PRINCIPAL = "principal_inventory";
const CREATED_AT = "2026-08-05T00:00:00.000Z" as IsoTimestamp;
const RECOVERED_AT = "2026-08-05T00:00:01.000Z" as IsoTimestamp;

function capsuleOwner(
  id = CAPSULE,
  workspaceId: SpaceId = SPACE,
): ResourceCapsuleOwner {
  return {
    kind: "Capsule",
    id,
    workspaceId,
    installingPrincipalId: PRINCIPAL,
  };
}

function resource(input: {
  readonly name: string;
  readonly phase: ResourcePhase;
  readonly owner?: ResourceShapeRecord["owner"];
  readonly generation?: number;
  readonly observedGeneration?: number;
  readonly spaceId?: SpaceId;
}): ResourceShapeRecord {
  const generation = input.generation ?? 1;
  return {
    id: formatResourceShapeId(
      input.spaceId ?? SPACE,
      "EdgeWorker",
      input.name,
    ),
    spaceId: input.spaceId ?? SPACE,
    kind: "EdgeWorker",
    name: input.name,
    managedBy: "portable_iac",
    spec: { name: input.name },
    phase: input.phase,
    generation,
    observedGeneration: input.observedGeneration ?? generation,
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

interface Backend {
  readonly label: string;
  setup(): Promise<{
    readonly stores: ResourceShapeStores;
    readonly close: () => Promise<void>;
  }>;
}

const backends: readonly Backend[] = [
  {
    label: "in-memory",
    async setup() {
      return {
        stores: createInMemoryResourceShapeStores(),
        close: async () => {},
      };
    },
  },
  {
    label: "cloudflare-d1",
    async setup() {
      const db = new SqliteFakeD1();
      await ensureD1OpenTofuLedgerSchema(db);
      return {
        stores: createD1ResourceShapeStores(db),
        close: async () => {},
      };
    },
  },
  {
    label: "postgres",
    async setup() {
      const client = await PGliteSqlClient.create();
      return {
        stores: createSqlResourceShapeStores(client),
        close: () => client.close(),
      };
    },
  },
];

for (const backend of backends) {
  describe(`Capsule owner Resource inventory (${backend.label})`, () => {
    let stores: ResourceShapeStores;
    let close: () => Promise<void>;

    beforeEach(async () => {
      const setup = await backend.setup();
      stores = setup.stores;
      close = setup.close;
    });

    afterEach(async () => {
      await close();
    });

    test("surfaces exact Capsule id claims across all lifecycle phases", async () => {
      const cases: readonly {
        readonly name: string;
        readonly phase: ResourcePhase;
        readonly owner?: ResourceShapeRecord["owner"];
        readonly generation?: number;
        readonly observedGeneration?: number;
        readonly spaceId?: SpaceId;
        readonly included: boolean;
      }[] = [
        {
          name: "ready",
          phase: "Ready",
          owner: capsuleOwner(),
          included: true,
        },
        {
          name: "applying",
          phase: "Applying",
          owner: capsuleOwner(),
          included: true,
        },
        {
          name: "deleting",
          phase: "Deleting",
          owner: capsuleOwner(),
          included: true,
        },
        {
          name: "failed",
          phase: "Failed",
          owner: capsuleOwner(),
          included: true,
        },
        {
          name: "ready-observed-mismatch",
          phase: "Ready",
          owner: capsuleOwner(),
          generation: 2,
          observedGeneration: 1,
          included: true,
        },
        {
          name: "other-capsule",
          phase: "Ready",
          owner: capsuleOwner(OTHER_CAPSULE),
          included: false,
        },
        {
          name: "other-workspace-owner",
          phase: "Ready",
          owner: capsuleOwner(CAPSULE, OTHER_SPACE),
          included: true,
        },
        {
          name: "other-workspace-row",
          phase: "Ready",
          owner: capsuleOwner(CAPSULE, OTHER_SPACE),
          spaceId: OTHER_SPACE,
          included: false,
        },
        {
          name: "legacy-principal-owner",
          phase: "Ready",
          owner: PRINCIPAL,
          included: false,
        },
      ];

      for (const item of cases) {
        await stores.resources.upsert(resource(item));
      }

      const page = await stores.resources.listByCapsuleOwnerPage(
        SPACE,
        CAPSULE,
        { limit: 100 },
      );
      expect(page.nextCursor).toBeUndefined();
      expect(page.items.map((item) => item.name)).toEqual(
        cases.filter((item) => item.included).map((item) => item.name).sort(),
      );
      expect(page.items.every((item) => item.owner?.kind === "Capsule")).toBe(
        true,
      );
    });

    test("surfaces invalid ownership evidence that claims the exact Capsule", async () => {
      const claims = [
        resource({
          name: "corrupt-owner",
          phase: "Failed",
          owner: {
            kind: "Capsule",
            id: CAPSULE,
            workspaceId: SPACE,
          } as unknown as ResourceShapeRecord["owner"],
        }),
        resource({
          name: "principal-mismatch",
          phase: "Applying",
          owner: {
            ...capsuleOwner(),
            installingPrincipalId: "principal_other",
          },
        }),
        resource({
          name: "workspace-mismatch",
          phase: "Deleting",
          owner: capsuleOwner(CAPSULE, OTHER_SPACE),
        }),
        resource({
          name: "unrelated-corrupt-owner",
          phase: "Ready",
          owner: {
            kind: "Capsule",
            id: OTHER_CAPSULE,
            workspaceId: SPACE,
          } as unknown as ResourceShapeRecord["owner"],
        }),
      ];
      for (const claim of claims) await stores.resources.upsert(claim);

      const page = await stores.resources.listByCapsuleOwnerPage(
        SPACE,
        CAPSULE,
        { limit: 100 },
      );

      expect(page.items.map((item) => item.name)).toEqual([
        "corrupt-owner",
        "principal-mismatch",
        "workspace-mismatch",
      ]);
    });

    test("preserves the source keyset cursor through filtered pages", async () => {
      const records = [
        resource({ name: "a-unrelated", phase: "Ready", owner: capsuleOwner(OTHER_CAPSULE) }),
        resource({ name: "b-applying", phase: "Applying", owner: capsuleOwner() }),
        resource({ name: "c-unrelated", phase: "Failed", owner: capsuleOwner(OTHER_CAPSULE) }),
        resource({ name: "d-deleting", phase: "Deleting", owner: capsuleOwner() }),
        resource({ name: "e-failed", phase: "Failed", owner: capsuleOwner() }),
      ];
      for (const record of records) await stores.resources.upsert(record);

      const seen: string[] = [];
      const pages: number[] = [];
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
        const page = await stores.resources.listByCapsuleOwnerPage(
          SPACE,
          CAPSULE,
          { limit: 1, ...(cursor ? { cursor } : {}) },
        );
        pages.push(page.items.length);
        seen.push(...page.items.map((item) => item.name));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }

      expect(seen).toEqual(["b-applying", "d-deleting", "e-failed"]);
      expect(pages).toEqual([0, 1, 0, 1, 1]);
    });

    test("atomically restores a coherent Resource and ResolutionLock pair", async () => {
      const degraded = {
        ...resource({
          name: "recoverable",
          phase: "Degraded",
          owner: capsuleOwner(),
        }),
        lastOperationRunId: "resource-run-recoverable",
      } satisfies ResourceShapeRecord;
      const lock = {
        resourceId: degraded.id,
        selectedImplementation: "test.edge-worker",
        targetPool: "default",
        target: "managed",
        implementationSnapshot: {
          shape: "EdgeWorker",
          implementation: "test.edge-worker",
          interfaces: { http: "native" },
          plugin: "test-edge-worker",
        },
        locked: true,
        reason: ["test recovery"],
        nativeResources: [{ type: "edge.worker", id: "recoverable" }],
        lockedAt: CREATED_AT,
        updatedAt: CREATED_AT,
      } satisfies ResolutionLockRecord;
      await stores.resources.upsert(degraded);
      await stores.locks.put(lock);
      const persisted = await stores.resources.get(degraded.id);
      expect(persisted).toBeDefined();
      if (!persisted) throw new Error("seeded Resource disappeared");

      const result = await stores.replaceResourceAggregate({
        record: {
          ...persisted,
          phase: "Ready",
          updatedAt: RECOVERED_AT,
        },
        lock: { ...lock, updatedAt: RECOVERED_AT },
        expectedResource: {
          generation: persisted.generation,
          phase: persisted.phase,
          updatedAt: persisted.updatedAt,
          revision: resourceRecordRevision(persisted),
        },
        expectedLock: lock,
      });
      expect(result.status).toBe("replaced");
      if (result.status !== "replaced") return;
      expect(result.record.phase).toBe("Ready");
      expect(result.record.updatedAt).toBe(RECOVERED_AT);
      expect(result.lock.updatedAt).toBe(RECOVERED_AT);
      expect(resourceRecordRevision(result.record)).toBe(
        resourceRecordRevision(persisted) + 1,
      );
    });

    test("atomically claims a Resource only with its exact lock and identity fence", async () => {
      const ready = {
        ...resource({
          name: "transition-claim",
          phase: "Ready",
          owner: capsuleOwner(),
        }),
        lastOperationRunId: "resource-run-transition-claim",
      } satisfies ResourceShapeRecord;
      const readyLock = {
        resourceId: ready.id,
        selectedImplementation: "test.edge-worker",
        targetPool: "default",
        target: "managed",
        locked: true,
        reason: ["test transition claim"],
        nativeResources: [{ type: "edge.worker", id: "transition-claim" }],
        lockedAt: CREATED_AT,
        updatedAt: CREATED_AT,
      } satisfies ResolutionLockRecord;
      await stores.resources.upsert(ready);
      await stores.locks.put(readyLock);
      const persisted = await stores.resources.get(ready.id);
      if (!persisted) throw new Error("seeded Resource disappeared");
      const input = {
        record: {
          ...persisted,
          pendingOperation: {
            runId: "resource-form-transition:claim",
            operation: "form_transition",
            operationKey: "claim",
            authority: "resource_claim",
            identityFenceRevision: 0,
          },
          updatedAt: RECOVERED_AT,
        },
        expectedResource: {
          generation: persisted.generation,
          phase: persisted.phase,
          updatedAt: persisted.updatedAt,
          revision: resourceRecordRevision(persisted),
        },
        expectedLock: readyLock,
        expectedIdentityFence: null,
      } as const;

      const first = await stores.claimResourceAggregate(input);
      const second = await stores.claimResourceAggregate(input);
      expect([first.status, second.status].sort()).toEqual([
        "claimed",
        "claimed",
      ]);
      const claimed = await stores.resources.get(ready.id);
      expect(claimed?.pendingOperation).toMatchObject({
        operation: "form_transition",
        operationKey: "claim",
      });
      expect(resourceRecordRevision(claimed!)).toBe(
        resourceRecordRevision(persisted) + 1,
      );
      expect(await stores.locks.get(ready.id)).toEqual(readyLock);

      const drifted = {
        ...resource({
          name: "transition-claim-lock-drift",
          phase: "Ready",
          owner: capsuleOwner(),
        }),
        lastOperationRunId: "resource-run-transition-claim-drift",
      } satisfies ResourceShapeRecord;
      const oldLock = {
        ...readyLock,
        resourceId: drifted.id,
        nativeResources: [
          { type: "edge.worker", id: "transition-claim-lock-drift" },
        ],
      } satisfies ResolutionLockRecord;
      await stores.resources.upsert(drifted);
      await stores.locks.put({
        ...oldLock,
        reason: [...oldLock.reason, "concurrent drift"],
      });
      const driftPersisted = await stores.resources.get(drifted.id);
      if (!driftPersisted) throw new Error("drift Resource disappeared");
      expect(await stores.claimResourceAggregate({
        record: {
          ...driftPersisted,
          pendingOperation: input.record.pendingOperation,
          updatedAt: RECOVERED_AT,
        },
        expectedResource: {
          generation: driftPersisted.generation,
          phase: driftPersisted.phase,
          updatedAt: driftPersisted.updatedAt,
          revision: resourceRecordRevision(driftPersisted),
        },
        expectedLock: oldLock,
        expectedIdentityFence: null,
      })).toMatchObject({ status: "conflict" });
      expect(
        (await stores.resources.get(drifted.id))?.pendingOperation,
      ).toBeUndefined();
    });

    test("atomically advances desired generation and the identity fence", async () => {
      const ready = {
        ...resource({
          name: "generation-transition",
          phase: "Ready",
          owner: capsuleOwner(),
        }),
        lastOperationRunId: "resource-run-generation-1",
      } satisfies ResourceShapeRecord;
      const readyLock = {
        resourceId: ready.id,
        selectedImplementation: "test.edge-worker",
        targetPool: "default",
        target: "managed",
        locked: true,
        reason: ["test generation transition"],
        nativeResources: [{ type: "edge.worker", id: "generation-transition" }],
        lockedAt: CREATED_AT,
        updatedAt: CREATED_AT,
      } satisfies ResolutionLockRecord;
      await stores.resources.upsert(ready);
      await stores.locks.put(readyLock);
      const persisted = await stores.resources.get(ready.id);
      if (!persisted) throw new Error("seeded Resource disappeared");

      const input = {
        record: {
          ...persisted,
          spec: { name: ready.name, revision: 2 },
          generation: 2,
          observedGeneration: 2,
          updatedAt: RECOVERED_AT,
        },
        lock: { ...readyLock, updatedAt: RECOVERED_AT },
        expectedResource: {
          generation: persisted.generation,
          phase: persisted.phase,
          updatedAt: persisted.updatedAt,
          revision: resourceRecordRevision(persisted),
        },
        expectedLock: readyLock,
        identityFenceAdvance: { expected: null },
      } as const;
      const winner = await stores.replaceResourceAggregate(input);
      const loser = await stores.replaceResourceAggregate(input);
      expect([winner.status, loser.status].sort()).toEqual([
        "conflict",
        "replaced",
      ]);
      const fence = await stores.getResourceIdentityFence(ready.id);
      expect(fence).toMatchObject({
        resourceId: ready.id,
        lastGeneration: 2,
        fenceRevision: 1,
      });
      expect((await stores.resources.get(ready.id))?.generation).toBe(2);
    });
  });
}
