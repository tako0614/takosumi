// Interface persistence parity across the in-memory reference store and both
// durable SQL implementations. The suite intentionally drives the stores only
// through InterfaceService so service-level conflict normalization is covered
// together with row/JSON round-trips and partial-unique-index behavior.

import { expect, test } from "bun:test";

import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import {
  createD1InterfaceStores,
  createInMemoryInterfaceStores,
  createSqlInterfaceStores,
  InterfaceService,
  InterfaceServiceError,
  type InterfaceStores,
} from "../../../../core/domains/interfaces/mod.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";

const NOW = "2026-07-13T15:00:00.000Z";

interface Backend {
  readonly label: string;
  setup(): Promise<{
    readonly stores: InterfaceStores;
    readonly teardown: () => Promise<void>;
  }>;
}

const backends: readonly Backend[] = [
  {
    label: "in-memory",
    setup: () =>
      Promise.resolve({
        stores: createInMemoryInterfaceStores(),
        teardown: () => Promise.resolve(),
      }),
  },
  {
    label: "cloudflare-d1",
    async setup() {
      const db = new SqliteFakeD1();
      await ensureD1OpenTofuLedgerSchema(db);
      return {
        stores: createD1InterfaceStores(db),
        teardown: () => Promise.resolve(),
      };
    },
  },
  {
    label: "postgres",
    async setup() {
      const client = await PGliteSqlClient.create();
      return {
        stores: createSqlInterfaceStores(client),
        teardown: () => client.close(),
      };
    },
  },
];

for (const backend of backends) {
  test(`Interface persistence contract (${backend.label})`, async () => {
    const { stores, teardown } = await backend.setup();
    let sequence = 0;
    const service = new InterfaceService({
      stores,
      now: () => NOW,
      newId: (prefix) => `${prefix}_${++sequence}`,
    });

    try {
      const created = await service.create({
        workspaceId: "workspace_parity",
        name: "primary-runtime",
        ownerRef: { kind: "Workspace", id: "workspace_parity" },
        labels: { tier: "gold", team: "runtime" },
        spec: {
          type: "example.runtime",
          version: "v1",
          document: {
            protocol: "https",
            nested: { enabled: true, ports: [443, 8443] },
          },
          inputs: {
            endpoint: {
              source: "literal",
              value: "https://runtime.example.test/invoke",
            },
            metadata: {
              source: "literal",
              value: { region: "test-1", replicas: 2 },
            },
          },
          access: {
            visibility: "workspace",
            resourceUriInput: "endpoint",
          },
        },
      });

      // Full Interface JSON survives the store representation in both
      // directions, including arbitrary document/input values and status.
      expect(await service.get(created.metadata.id)).toEqual(created);
      expect(
        await service.list({
          workspaceId: "workspace_parity",
          ownerKind: "Workspace",
          ownerId: "workspace_parity",
        }),
      ).toEqual([created]);

      // Lifecycle conditions intentionally do not advance resolvedRevision.
      // The exact-record fence must still reject a stale condition-only write
      // so plan/drift observers cannot overwrite each other on durable stores.
      const conditionGuard = {
        generation: created.metadata.generation,
        resolvedRevision: created.status.resolvedRevision,
        record: created,
      };
      const pendingObservation = {
        ...created,
        status: {
          ...created.status,
          conditions: [
            ...(created.status.conditions ?? []),
            {
              type: "ObservationPending",
              status: "true" as const,
              reason: "PlanObservationPending",
              message: "plan_alpha",
              observedGeneration: created.metadata.generation,
              lastTransitionAt: NOW,
            },
          ],
        },
      };
      const competingObservation = {
        ...pendingObservation,
        status: {
          ...pendingObservation.status,
          conditions: pendingObservation.status.conditions.map((condition) =>
            condition.type === "ObservationPending"
              ? { ...condition, message: "plan_beta" }
              : condition,
          ),
        },
      };
      expect(
        await stores.interfaces.compareAndSet(
          pendingObservation,
          conditionGuard,
        ),
      ).toBe(true);
      expect(
        await stores.interfaces.compareAndSet(
          competingObservation,
          conditionGuard,
        ),
      ).toBe(false);
      expect(await service.get(created.metadata.id)).toEqual(
        pendingObservation,
      );

      const bindingRequest = {
        subjectRef: { kind: "Principal" as const, id: "principal_parity" },
        permissions: ["runtime.invoke"],
        delivery: { type: "none" },
      };
      const firstBinding = await service.createBinding(
        created.metadata.id,
        bindingRequest,
      );
      expect(firstBinding.status.phase).toBe("Ready");
      expect(
        await service.getBinding(created.metadata.id, firstBinding.metadata.id),
      ).toEqual(firstBinding);
      expect(await service.listBindings(created.metadata.id)).toEqual([
        firstBinding,
      ]);

      await expectServiceError(
        service.createBinding(created.metadata.id, bindingRequest),
        "already_exists",
      );
      const revoked = await service.revokeBinding(
        created.metadata.id,
        firstBinding.metadata.id,
      );
      expect(revoked.status.phase).toBe("Revoked");

      // The active-subject uniqueness constraint excludes revoked records, so
      // an explicit re-grant creates a new durable Binding instead of reviving
      // or mutating the audit history.
      const replacementBinding = await service.createBinding(
        created.metadata.id,
        bindingRequest,
      );
      expect(replacementBinding.metadata.id).not.toBe(firstBinding.metadata.id);
      expect(replacementBinding.status.phase).toBe("Ready");
      expect(
        (await service.listBindings(created.metadata.id)).map(
          (binding) => binding.status.phase,
        ),
      ).toEqual(["Revoked", "Ready"]);

      // Two writers using the same generation/revision fence must produce one
      // winner and one normalized service conflict on every backend.
      const writes = await Promise.allSettled([
        service.update(
          created.metadata.id,
          { labels: { writer: "alpha" } },
          created.metadata.generation,
          undefined,
          created.status.resolvedRevision,
        ),
        service.update(
          created.metadata.id,
          { labels: { writer: "beta" } },
          created.metadata.generation,
          undefined,
          created.status.resolvedRevision,
        ),
      ]);
      expect(
        writes.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejectedWrites = writes.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      expect(rejectedWrites).toHaveLength(1);
      expect(rejectedWrites[0]?.reason).toBeInstanceOf(InterfaceServiceError);
      expect((rejectedWrites[0]?.reason as InterfaceServiceError).code).toBe(
        "conflict",
      );

      const concurrentWinner = await service.get(created.metadata.id);
      expect(concurrentWinner.metadata.generation).toBe(2);
      expect(["alpha", "beta"]).toContain(
        concurrentWinner.metadata.labels?.writer,
      );

      const occupied = await service.create({
        workspaceId: "workspace_parity",
        name: "occupied-runtime",
        ownerRef: { kind: "Workspace", id: "workspace_parity" },
        spec: {
          type: "example.runtime",
          version: "v1",
          document: { protocol: "https" },
          inputs: {
            endpoint: {
              source: "literal",
              value: "https://occupied.example.test/invoke",
            },
          },
          access: {
            visibility: "workspace",
            resourceUriInput: "endpoint",
          },
        },
      });
      await expectServiceError(
        service.update(
          concurrentWinner.metadata.id,
          { name: occupied.metadata.name },
          concurrentWinner.metadata.generation,
          undefined,
          concurrentWinner.status.resolvedRevision,
        ),
        "conflict",
      );
      expect(
        (await service.get(concurrentWinner.metadata.id)).metadata.name,
      ).toBe("primary-runtime");

      const retired = await service.retire(
        concurrentWinner.metadata.id,
        concurrentWinner.metadata.generation,
        undefined,
        concurrentWinner.status.resolvedRevision,
      );
      expect(retired.status.phase).toBe("Retired");
      expect(
        (
          await service.getBinding(
            retired.metadata.id,
            replacementBinding.metadata.id,
          )
        ).status.phase,
      ).toBe("Revoked");

      // Active-name uniqueness excludes retired rows. Reusing a human name
      // creates a new identity while the retired record remains addressable.
      const recreated = await service.create({
        workspaceId: "workspace_parity",
        name: retired.metadata.name,
        ownerRef: { kind: "Workspace", id: "workspace_parity" },
        spec: {
          type: "example.runtime",
          version: "v2",
          document: { protocol: "https", replacement: true },
          inputs: {
            endpoint: {
              source: "literal",
              value: "https://replacement.example.test/invoke",
            },
          },
          access: {
            visibility: "workspace",
            resourceUriInput: "endpoint",
          },
        },
      });
      expect(recreated.metadata.id).not.toBe(retired.metadata.id);
      expect(recreated.status.phase).toBe("Resolved");
      expect(
        await service.list({
          workspaceId: "workspace_parity",
          includeRetired: true,
        }),
      ).toContainEqual(retired);
      expect(await service.get(retired.metadata.id)).toEqual(retired);
    } finally {
      await teardown();
    }
  });
}

async function expectServiceError(
  promise: Promise<unknown>,
  code: InterfaceServiceError["code"],
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(InterfaceServiceError);
  expect((error as InterfaceServiceError).code).toBe(code);
}
