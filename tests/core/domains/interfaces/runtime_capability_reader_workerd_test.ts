import { describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import type {
  InstalledFormReference,
  NativeResourceRef,
} from "takosumi-contract";
import { formRefKey, formRefOfInstalled } from "takosumi-contract";
import type { Interface, InterfaceBinding } from "takosumi-contract/interfaces";
import type { D1Like } from "../../../../core/domains/resource-shape/d1_stores.ts";
import { createD1ResourceShapeStores } from "../../../../core/domains/resource-shape/d1_stores.ts";
import { createD1InterfaceStores } from "../../../../core/domains/interfaces/d1_stores.ts";
import type {
  ResolutionLockRecord,
  ResourceShapeRecord,
} from "../../../../core/domains/resource-shape/records.ts";
import {
  D1RuntimeCapabilityReader,
  type RuntimeCapabilityReadInput,
} from "../../../../core/domains/interfaces/runtime_capability_reader.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";

const NOW = "2026-08-01T00:00:00.000Z";
const FORM: InstalledFormReference = {
  type: "edge_worker",
  version: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
  packageDigest: `sha256:${"b".repeat(64)}`,
};
const RESOURCE_ID = "tkrn:ws_runtime_workerd:EdgeWorker:app";
const AUDIENCE = "https://runtime.example/";

describe("D1RuntimeCapabilityReader (workerd D1)", () => {
  test("joins exact durable rows in one first-primary statement and fails closed", async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-17",
      modules: [
        {
          type: "ESModule",
          path: "runtime-capability-reader-workerd.mjs",
          contents: "export default {fetch(){return new Response(\"ok\")}}",
        },
      ],
      d1Databases: { CONTROL: "runtime-capability-reader-workerd" },
    });
    try {
      const rawDb = await runtime.getD1Database("CONTROL");
      await ensureD1OpenTofuLedgerSchema(rawDb);
      const records = fixture();
      await seed(rawDb as unknown as D1Like, records);

      const projection = await rawDb
        .prepare(
          "select oauth_resource_uri from interfaces where id = ? limit 1",
        )
        .bind(records.iface.metadata.id)
        .first<{ readonly oauth_resource_uri: string | null }>();
      expect(projection?.oauth_resource_uri).toBe(AUDIENCE);

      const observed = observeD1(rawDb as unknown as D1Like);
      const reader = new D1RuntimeCapabilityReader(observed.db);
      const result = await reader.read(input());
      expect(result?.resourceGeneration).toBe(3);
      expect(result?.resourceRevisionId).toBe("run_apply_3");
      expect(result?.nativeResources).toEqual(records.lock.nativeResources);
      expect(observed.primarySessions).toBe(1);
      expect(observed.terminalStatements).toBe(1);
      expect(observed.rowsRead).toHaveLength(1);
      expect(observed.rowsRead[0]).toBeLessThanOrEqual(8);

      observed.reset();
      expect(
        await reader.read(input({ interfaceResolvedRevision: 3 })),
      ).toBeUndefined();
      expect(observed.primarySessions).toBe(1);
      expect(observed.terminalStatements).toBe(1);
      expect(observed.rowsRead[0]).toBeLessThanOrEqual(8);

      observed.reset();
      const revoked = await rawDb
        .prepare(
          "update interface_bindings set phase = ? where id = ?",
        )
        .bind("Revoked", records.binding.metadata.id)
        .run();
      expect(revoked.meta?.changes).toBe(1);
      expect(await reader.read(input())).toBeUndefined();
      expect(observed.primarySessions).toBe(1);
      expect(observed.terminalStatements).toBe(1);
      expect(observed.rowsRead[0]).toBeLessThanOrEqual(8);
    } finally {
      await runtime.dispose();
    }
  }, 10_000);
});

function fixture(): {
  readonly resource: ResourceShapeRecord;
  readonly lock: ResolutionLockRecord;
  readonly iface: Interface;
  readonly binding: InterfaceBinding;
} {
  const native: NativeResourceRef = {
    type: "worker",
    id: "native-app",
    form: FORM,
  };
  const resource: ResourceShapeRecord = {
    id: RESOURCE_ID,
    spaceId: "ws_runtime_workerd",
    kind: "EdgeWorker",
    form: FORM,
    name: "app",
    managedBy: "opentofu",
    spec: { name: "app" },
    phase: "Ready",
    generation: 3,
    observedGeneration: 3,
    revision: 2,
    execution: {
      runId: "run_apply_3",
      stateGeneration: 3,
      stateRef: "state:3",
      updatedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const lock: ResolutionLockRecord = {
    resourceId: RESOURCE_ID,
    form: FORM,
    selectedImplementation: "edge_worker",
    target: "target-a",
    locked: true,
    reason: [],
    portability: "portable",
    nativeResources: [native],
    lockedAt: NOW,
    updatedAt: NOW,
  };
  const iface: Interface = {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "Interface",
    metadata: {
      id: "if_runtime_workerd",
      workspaceId: "ws_runtime_workerd",
      name: "runtime",
      ownerRef: { kind: "Resource", id: RESOURCE_ID },
      generation: 2,
      materializedFrom: {
        source: "form_descriptor",
        formRefKey: formRefKey(formRefOfInstalled(FORM)),
        formSchemaDigest: FORM.schemaDigest,
        descriptorName: "runtime",
        descriptorVersion: "1",
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    spec: {
      type: "app.runtime",
      version: "1",
      document: {},
      access: { visibility: "workspace" },
    },
    status: {
      phase: "Resolved",
      observedGeneration: 2,
      resolvedRevision: 4,
      resourceUri: AUDIENCE,
    },
  };
  const ifaceSource = iface.metadata.materializedFrom;
  if (!ifaceSource || ifaceSource.source !== "form_descriptor") {
    throw new Error("workerd fixture Interface lineage is missing");
  }
  const binding: InterfaceBinding = {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "InterfaceBinding",
    metadata: {
      id: "ifb_runtime_workerd",
      workspaceId: "ws_runtime_workerd",
      generation: 1,
      materializedFrom: {
        source: "form_host_descriptor",
        formRefKey: ifaceSource.formRefKey,
        descriptorName: "runtime",
        descriptorVersion: "1",
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    spec: {
      interfaceId: iface.metadata.id,
      subjectRef: { kind: "Resource", id: RESOURCE_ID },
      permissions: ["read"],
      delivery: { type: "none" },
    },
    status: {
      phase: "Ready",
      observedInterfaceRevision: 4,
    },
  };
  return { resource, lock, iface, binding };
}

function input(
  overrides: Partial<RuntimeCapabilityReadInput> = {},
): RuntimeCapabilityReadInput {
  return {
    workspaceId: "ws_runtime_workerd",
    resourceId: RESOURCE_ID,
    resourceKind: "EdgeWorker",
    interfaceId: "if_runtime_workerd",
    interfaceBindingId: "ifb_runtime_workerd",
    bindingSubject: { kind: "Resource", id: RESOURCE_ID },
    requiredPermission: "read",
    interfaceResolvedRevision: 4,
    audience: AUDIENCE,
    ...overrides,
  };
}

async function seed(db: D1Like, records: ReturnType<typeof fixture>): Promise<void> {
  const resourceStores = createD1ResourceShapeStores(db);
  const created = await resourceStores.resources.create(records.resource);
  expect(created.status).toBe("created");
  await resourceStores.locks.put(records.lock);

  const interfaceStores = createD1InterfaceStores(db);
  expect(await interfaceStores.interfaces.create(records.iface)).toBe(true);
  expect(
    await interfaceStores.interfaces.claimOAuth2Resource({
      record: records.iface,
      resource: AUDIENCE,
    }),
  ).toBe(true);
  expect(await interfaceStores.bindings.create(records.binding)).toBe(true);
}

interface ObservedD1 {
  readonly db: D1Like;
  readonly primarySessions: number;
  readonly terminalStatements: number;
  readonly rowsRead: readonly number[];
  reset(): void;
}

interface SessionD1 extends D1Like {
  withSession?(bookmark: "first-primary"): D1Like;
}

function observeD1(raw: D1Like): ObservedD1 {
  let primarySessions = 0;
  let terminalStatements = 0;
  let rowsRead: number[] = [];
  const source = raw as SessionD1;

  const wrap = (db: D1Like): D1Like => {
    const observed: D1Like = {
      prepare(query: string) {
        const statement = db.prepare(query);
        const wrapped = {
          bind(...values: readonly unknown[]) {
            return wrapPrepared(statement.bind(...values));
          },
          async first<T = unknown>() {
            terminalStatements += 1;
            return await statement.first<T>();
          },
          async all<T = unknown>() {
            terminalStatements += 1;
            const result = await statement.all<T>();
            if (result.meta?.rows_read !== undefined) {
              rowsRead.push(result.meta.rows_read);
            }
            return result;
          },
          async run<T = unknown>() {
            terminalStatements += 1;
            return await statement.run<T>();
          },
        };
        return wrapped as ReturnType<D1Like["prepare"]>;
      },
    };
    const withSession = (db as SessionD1).withSession;
    if (typeof withSession === "function") {
      (observed as SessionD1).withSession = (bookmark) => {
        primarySessions += 1;
        return wrap(withSession.call(db, bookmark));
      };
    }
    return observed;
  };

  const wrapPrepared = (
    statement: ReturnType<D1Like["prepare"]>,
  ): ReturnType<D1Like["prepare"]> => {
    const wrapped = {
      bind(...values: readonly unknown[]) {
        return wrapPrepared(statement.bind(...values));
      },
      async first<T = unknown>() {
        terminalStatements += 1;
        return await statement.first<T>();
      },
      async all<T = unknown>() {
        terminalStatements += 1;
        const result = await statement.all<T>();
        if (result.meta?.rows_read !== undefined) {
          rowsRead.push(result.meta.rows_read);
        }
        return result;
      },
      async run<T = unknown>() {
        terminalStatements += 1;
        return await statement.run<T>();
      },
    };
    return wrapped as ReturnType<D1Like["prepare"]>;
  };

  const observedDb = wrap(raw);
  return {
    db: observedDb,
    get primarySessions() {
      return primarySessions;
    },
    get terminalStatements() {
      return terminalStatements;
    },
    get rowsRead() {
      return rowsRead;
    },
    reset() {
      primarySessions = 0;
      terminalStatements = 0;
      rowsRead = [];
    },
  };
}
