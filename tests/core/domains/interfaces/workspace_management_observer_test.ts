import { afterEach, expect, test } from "bun:test";
import type { Interface } from "takosumi-contract/interfaces";
import type { Workspace } from "takosumi-contract/workspaces";

import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import {
  InMemoryOpenTofuControlStore,
  WorkspaceManagementAdmissionConflictError,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import {
  createD1InterfaceStores,
  createInMemoryInterfaceStores,
  createSqlInterfaceStores,
  InterfaceService,
  type InterfaceStores,
} from "../../../../core/domains/interfaces/mod.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";

const NOW = "2026-09-08T00:00:00.000Z";
const pgClients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

function workspace(id: string): Workspace {
  return {
    id,
    handle: id.replaceAll("_", "-"),
    displayName: "Observer Workspace",
    type: "personal",
    ownerUserId: "observer-owner",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function record(workspaceId: string, id: string): Interface {
  return {
    apiVersion: "takosumi.dev/v1alpha1",
    kind: "Interface",
    metadata: {
      id,
      workspaceId,
      name: "runtime",
      ownerRef: { kind: "Capsule", id: "capsule_observer" },
      generation: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
    spec: {
      type: "example.runtime",
      version: "v1",
      document: { transport: "https" },
      access: { visibility: "workspace" },
    },
    status: {
      phase: "Resolved",
      observedGeneration: 1,
      resolvedRevision: 1,
      conditions: [],
    },
  };
}

function observation(
  current: Interface,
  message: string,
  phase = current.status.phase,
): Interface {
  return {
    ...current,
    metadata: { ...current.metadata, updatedAt: NOW },
    status: {
      ...current.status,
      phase,
      conditions: [
        {
          type: "ObservationPending",
          status: "true",
          reason: "PlanObservationPending",
          message,
          observedGeneration: current.metadata.generation,
          lastTransitionAt: NOW,
        },
      ],
    },
  };
}

function authority(workspaceId: string, managementEpoch: number) {
  return {
    workspaceId,
    managementState: "active" as const,
    managementEpoch,
  };
}

type Backend = {
  readonly label: string;
  readonly control: OpenTofuControlStore;
  readonly stores: InterfaceStores;
};

async function backends(): Promise<readonly Backend[]> {
  const memoryControl = new InMemoryOpenTofuControlStore();
  await memoryControl.putWorkspace(workspace("workspace_observer_memory"));

  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  const postgresControl = new SqlOpenTofuControlStore({ client: pgClient });
  await postgresControl.putWorkspace(workspace("workspace_observer_postgres"));

  const d1 = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(d1);
  const d1Control = new CloudflareD1OpenTofuControlStore(d1);
  await d1Control.putWorkspace(workspace("workspace_observer_d1"));

  return [
    {
      label: "memory",
      control: memoryControl,
      stores: createInMemoryInterfaceStores({
        workspaceManagementAuthority: memoryControl,
      }),
    },
    {
      label: "postgres",
      control: postgresControl,
      stores: createSqlInterfaceStores(pgClient),
    },
    {
      label: "d1",
      control: d1Control,
      stores: createD1InterfaceStores(d1),
    },
  ];
}

test("queued Interface observers are fenced by the persisted Workspace across stores", async () => {
  for (const { label, control, stores } of await backends()) {
    const seededWorkspaceId = `workspace_observer_${label}`;
    const seeded = record(seededWorkspaceId, `if_observer_${label}`);
    expect(
      await stores.interfaces.create(seeded),
      `${label}:create`,
    ).toBe(true);
    const pending = observation(seeded, "plan-before-drain");
    expect(
      await stores.interfaces.compareAndSet(pending, {
        generation: 1,
        resolvedRevision: 1,
        record: seeded,
        requireActiveWorkspace: true,
      }),
      `${label}:active observer admission`,
    ).toBe(true);

    const currentManagement = await control.getWorkspaceManagement(
      seededWorkspaceId,
    );
    expect(currentManagement, `${label}:management seed`).toBeDefined();
    await control.beginWorkspaceDraining(
      seededWorkspaceId,
      authority(seededWorkspaceId, currentManagement!.managementEpoch),
    );

    const drainedCandidate = observation(pending, "plan-during-drain");
    await expect(
      stores.interfaces.compareAndSet(drainedCandidate, {
        generation: 1,
        resolvedRevision: 1,
        record: pending,
        requireActiveWorkspace: true,
      }),
      `${label}:drained observer refusal`,
    ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    expect(
      await stores.interfaces.get(seeded.metadata.id),
      `${label}:refusal leaves row exact`,
    ).toEqual(pending);

    // Terminal lifecycle convergence is deliberately unguarded and remains
    // allowed after drain.
    const terminal = observation(pending, "terminal", "Terminating");
    expect(
      await stores.interfaces.compareAndSet(terminal, {
        generation: 1,
        resolvedRevision: 1,
        record: pending,
      }),
      `${label}:terminal convergence`,
    ).toBe(true);

    // A replacement payload cannot borrow an active Workspace to evade the
    // guard; the exact prior record and persisted workspace remain authoritative.
    const crossWorkspace = {
      ...terminal,
      metadata: { ...terminal.metadata, workspaceId: "workspace_other" },
    };
    expect(
      await stores.interfaces.compareAndSet(crossWorkspace, {
        generation: 1,
        resolvedRevision: 1,
        record: terminal,
        requireActiveWorkspace: true,
      }),
      `${label}:cross-workspace replacement`,
    ).toBe(false);
    expect(
      await stores.interfaces.get(seeded.metadata.id),
      `${label}:cross-workspace leaves row exact`,
    ).toEqual(terminal);

    const orphaned = record("workspace_missing", `if_missing_${label}`);
    await stores.interfaces.create(orphaned);
    await expect(stores.interfaces.compareAndSet(observation(orphaned, "missing"), {
      generation: 1,
      resolvedRevision: 1,
      record: orphaned,
      requireActiveWorkspace: true,
    }), `${label}:missing Workspace refuses admission`)
      .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    expect(await stores.interfaces.get(orphaned.metadata.id)).toEqual(orphaned);
  }
});

test("InterfaceService skips queued observer markers after Workspace drain", async () => {
  const control = new InMemoryOpenTofuControlStore();
  const workspaceId = "workspace_observer_service";
  await control.putWorkspace(workspace(workspaceId));
  const stores = createInMemoryInterfaceStores({
    workspaceManagementAuthority: control,
  });
  const service = new InterfaceService({
    stores,
    now: () => NOW,
    newId: () => "if_observer_service",
  });
  const created = await service.create({
    workspaceId,
    name: "runtime",
    ownerRef: { kind: "Capsule", id: "capsule_observer" },
    spec: {
      type: "example.runtime",
      version: "v1",
      document: { transport: "https" },
      access: { visibility: "workspace" },
    },
  });
  const currentManagement = await control.getWorkspaceManagement(workspaceId);
  const referenceBase = record(workspaceId, "if_observer_reference");
  const reference: Interface = {
    ...referenceBase,
    metadata: {
      ...referenceBase.metadata,
      name: "reference",
      ownerRef: { kind: "Workspace", id: workspaceId },
    },
    spec: {
      ...created.spec,
      inputs: {
        endpoint: {
          source: "capsule_output",
          capsuleId: "capsule_observer",
          outputName: "endpoint",
        },
      },
    },
  };
  await stores.interfaces.create(reference);
  await control.beginWorkspaceDraining(
    workspaceId,
    authority(workspaceId, currentManagement!.managementEpoch),
  );

  await service.markCapsulePlanPending(
    workspaceId,
    "capsule_observer",
    "plan-during-drain",
  );
  await service.markCapsuleTerminating(workspaceId, "capsule_observer");
  expect(await service.get(created.metadata.id)).toEqual(created);
  expect(await service.get(reference.metadata.id)).toEqual(reference);
});
