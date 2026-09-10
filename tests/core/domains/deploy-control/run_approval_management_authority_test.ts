import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Run } from "takosumi-contract/runs";
import type { Workspace } from "takosumi-contract/workspaces";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
  type StoredRunRecord,
  type TransitionRunInput,
  type TransitionRunResult,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const NOW = "2026-09-10T00:00:00.000Z";
const pgClients: PGliteSqlClient[] = [];

setDefaultTimeout(20_000);

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

type Kind = "plan" | "restore";

interface Adapter {
  readonly label: string;
  readonly store: OpenTofuControlStore;
  readonly reopen: () => OpenTofuControlStore;
  readonly resumeManagement?: (workspaceId: string) => Promise<void>;
}

async function adapters(): Promise<readonly Adapter[]> {
  const pg = await PGliteSqlClient.create();
  pgClients.push(pg);
  const d1 = new SqliteFakeD1();
  const memory = new InMemoryOpenTofuControlStore();
  return [
    { label: "memory", store: memory, reopen: () => memory },
    {
      label: "postgres",
      store: new SqlOpenTofuControlStore({ client: pg }),
      reopen: () => new SqlOpenTofuControlStore({ client: pg }),
      async resumeManagement(workspaceId) {
        await pg.query(
          "update takosumi_workspaces set management_state = 'active', management_epoch = management_epoch + 1 where id = $1 and management_state = 'draining'",
          [workspaceId],
        );
      },
    },
    {
      label: "d1",
      store: new CloudflareD1OpenTofuControlStore(d1),
      reopen: () => new CloudflareD1OpenTofuControlStore(d1),
      async resumeManagement(workspaceId) {
        await d1
          .prepare(
            "update workspaces set management_state = 'active', management_epoch = management_epoch + 1 where id = ? and management_state = 'draining'",
          )
          .bind(workspaceId)
          .run();
      },
    },
  ];
}

function workspace(id: string): Workspace {
  return {
    id,
    handle: `handle-${id}`,
    displayName: id,
    type: "personal",
    ownerUserId: `owner-${id}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function activeAuthority(
  store: OpenTofuControlStore,
  workspaceId: string,
): Promise<WorkspaceManagementAuthority> {
  const management = await store.getWorkspaceManagement(workspaceId);
  if (!management || management.managementState !== "active") {
    throw new Error(`Workspace ${workspaceId} is not active`);
  }
  return {
    workspaceId,
    managementState: "active",
    managementEpoch: management.managementEpoch,
  };
}

function planRun(id: string, workspaceId: string): PlanRun {
  return {
    id,
    workspaceId,
    source: {
      kind: "git",
      url: "https://example.test/approval-authority.git",
      commit: "0123456789abcdef0123456789abcdef01234567",
    },
    sourceDigest: "sha256:source",
    operation: "update",
    runnerProfileId: "runner",
    variablesDigest: "sha256:variables",
    executionInputsDigest: "sha256:inputs",
    requiredProviders: [],
    requiredProviderRequirements: [],
    status: "waiting_approval",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function restoreRun(id: string, workspaceId: string): Run {
  return {
    id,
    workspaceId,
    type: "restore",
    status: "waiting_approval",
    backupId: `backup-${id}`,
    capsuleId: "capsule-approval",
    restoreStateGeneration: 1,
    createdBy: "owner",
    createdAt: NOW,
  };
}

async function admit(
  store: OpenTofuControlStore,
  kind: Kind,
  row: PlanRun | Run,
  authority: WorkspaceManagementAuthority,
): Promise<void> {
  if (kind === "plan") {
    const result = await store.preparePlanRun({
      run: row as PlanRun,
      inputs: { planRunId: row.id, variables: {} },
      expectedWorkspaceManagementAuthority: authority,
    });
    expect(result.status).toBe("created");
    return;
  }
  const result = await store.beginRestoreRun(row as Run, authority);
  expect(result.status).toBe("created");
}

async function get(
  store: OpenTofuControlStore,
  kind: Kind,
  id: string,
): Promise<PlanRun | Run | undefined> {
  return kind === "plan"
    ? await store.getPlanRun(id)
    : await store.getBackupRun(id);
}

async function put(
  store: OpenTofuControlStore,
  kind: Kind,
  row: PlanRun | Run,
): Promise<void> {
  if (kind === "plan") {
    await store.putPlanRun(row as PlanRun);
  } else {
    await store.putBackupRun(row as Run);
  }
}

/**
 * The option is being added to the shared store contract in the coupled store
 * lane. Keep this test source-compatible with the pre-option checkout while
 * still exercising the exact public transitionRun seam once it lands.
 */
type StoredAuthorityTransition = TransitionRunInput & {
  readonly requireStoredManagementAuthority?: boolean;
};

function transition(
  store: OpenTofuControlStore,
  input: StoredAuthorityTransition,
): Promise<TransitionRunResult> {
  return store.transitionRun(input as TransitionRunInput);
}

function publicProjectionHasNoAuthority(value: unknown): void {
  expect(
    value && typeof value === "object"
      ? Object.prototype.hasOwnProperty.call(
          value,
          "workspaceManagementAuthority",
        )
      : false,
  ).toBe(false);
  expect(JSON.stringify(value)).not.toContain("workspaceManagementAuthority");
}

function currentTransition(
  kind: Kind,
  row: PlanRun | Run,
  status: "succeeded" | "queued",
  authority: WorkspaceManagementAuthority,
): StoredAuthorityTransition {
  return {
    id: row.id,
    kind,
    expectFrom: ["waiting_approval"],
    expectedWorkspaceManagementAuthority: authority,
    requireStoredManagementAuthority: true,
    run: { ...row, status } as StoredRunRecord,
  };
}

test("approval transitions require the stored original Workspace authority", async () => {
  for (const adapter of await adapters()) {
    const { store, label } = adapter;
    for (const kind of ["plan", "restore"] as const) {
      const workspaceId = `approval-active-${label}-${kind}`;
      await store.putWorkspace(workspace(workspaceId));
      const authority = await activeAuthority(store, workspaceId);
      const row =
        kind === "plan"
          ? planRun(`approval-active-${label}-${kind}`, workspaceId)
          : restoreRun(`approval-active-${label}-${kind}`, workspaceId);
      await admit(store, kind, row, authority);

      const nextStatus = kind === "plan" ? "succeeded" : "queued";
      const approved = await transition(
        store,
        currentTransition(kind, row, nextStatus, authority),
      );
      expect(approved.won, `${label}:${kind}`).toBe(true);
      expect((await get(store, kind, row.id))?.status, `${label}:${kind}`).toBe(
        nextStatus,
      );
      publicProjectionHasNoAuthority(await get(store, kind, row.id));
      publicProjectionHasNoAuthority(
        (await store.listRunsByWorkspace(workspaceId)).find(
          (candidate) => candidate.id === row.id,
        ),
      );
    }
  }
});

test("approval transitions are refused during drain and after durable resume under a new epoch", async () => {
  for (const adapter of await adapters()) {
    const { store, label } = adapter;
    for (const kind of ["plan", "restore"] as const) {
      const workspaceId = `approval-drain-${label}-${kind}`;
      await store.putWorkspace(workspace(workspaceId));
      const original = await activeAuthority(store, workspaceId);
      const row =
        kind === "plan"
          ? planRun(`approval-drain-${label}-${kind}`, workspaceId)
          : restoreRun(`approval-drain-${label}-${kind}`, workspaceId);
      await admit(store, kind, row, original);
      const beforeDrain = await get(store, kind, row.id);

      expect(
        (await store.beginWorkspaceDraining(workspaceId, original)).status,
        `${label}:${kind}:drain`,
      ).toBe("started");
      const nextStatus = kind === "plan" ? "succeeded" : "queued";
      const deniedDuringDrain = await transition(
        store,
        currentTransition(kind, row, nextStatus, original),
      );
      expect(deniedDuringDrain.won, `${label}:${kind}:drain`).toBe(false);
      expect(await get(store, kind, row.id), `${label}:${kind}:drain`).toEqual(
        beforeDrain,
      );
      publicProjectionHasNoAuthority(await get(store, kind, row.id));

      if (!adapter.resumeManagement) continue;
      await adapter.resumeManagement(workspaceId);
      const reopened = adapter.reopen();
      const resumed = await reopened.getWorkspaceManagement(workspaceId);
      expect(resumed?.managementState, `${label}:${kind}:resume`).toBe("active");
      expect(resumed?.managementEpoch, `${label}:${kind}:resume`).toBe(3);

      // Supplying the current N+2 tuple cannot authorize a Run admitted under N.
      const currentAuthority: WorkspaceManagementAuthority = {
        workspaceId,
        managementState: "active",
        managementEpoch: 3,
      };
      const deniedAfterResume = await transition(
        reopened,
        currentTransition(kind, row, nextStatus, currentAuthority),
      );
      expect(deniedAfterResume.won, `${label}:${kind}:resume`).toBe(false);
      expect(await get(reopened, kind, row.id), `${label}:${kind}:resume`).toEqual(
        beforeDrain,
      );
      publicProjectionHasNoAuthority(await get(reopened, kind, row.id));
      publicProjectionHasNoAuthority(
        (await reopened.listRunsByWorkspace(workspaceId)).find(
          (candidate) => candidate.id === row.id,
        ),
      );
    }
  }
});

test("approval transitions refuse tupleless legacy rows without backfilling authority", async () => {
  for (const adapter of await adapters()) {
    const { store, label } = adapter;
    for (const kind of ["plan", "restore"] as const) {
      const workspaceId = `approval-legacy-${label}-${kind}`;
      await store.putWorkspace(workspace(workspaceId));
      const authority = await activeAuthority(store, workspaceId);
      const row =
        kind === "plan"
          ? planRun(`approval-legacy-${label}-${kind}`, workspaceId)
          : restoreRun(`approval-legacy-${label}-${kind}`, workspaceId);
      await put(store, kind, row);
      const before = await get(store, kind, row.id);
      const nextStatus = kind === "plan" ? "succeeded" : "queued";
      const denied = await transition(
        store,
        currentTransition(kind, row, nextStatus, authority),
      );
      expect(denied.won, `${label}:${kind}`).toBe(false);
      expect(await get(store, kind, row.id), `${label}:${kind}`).toEqual(before);
      publicProjectionHasNoAuthority(await get(store, kind, row.id));
    }
  }
});
