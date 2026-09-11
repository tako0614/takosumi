import { expect, test } from "bun:test";

import { D1GitInstallPlanStore } from "../../../../core/domains/install-plans/d1_store.ts";
import { SqlGitInstallPlanStore } from "../../../../core/domains/install-plans/sql_store.ts";
import {
  InMemoryGitInstallPlanStore,
  publicGitInstallPlan,
  type GitInstallPlanStore,
  type StoredGitInstallPlan,
} from "../../../../core/domains/install-plans/store.ts";
import type {
  SqlClient,
  SqlTransaction,
} from "../../../../core/adapters/storage/sql.ts";
import {
  InMemoryOpenTofuControlStore,
  WorkspaceManagementAdmissionConflictError,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

test("Git install-plan store has idempotency and CAS parity", async () => {
  const postgres = await PGliteSqlClient.create();
  const d1 = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(d1);
  const memoryControl = new InMemoryOpenTofuControlStore();
  await memoryControl.putWorkspace(workspace("ws_one"));
  await memoryControl.putWorkspace(workspace("ws_two"));
  await seedPostgresWorkspace(postgres, "ws_one");
  await seedPostgresWorkspace(postgres, "ws_two");
  await seedD1Workspace(d1, "ws_one");
  await seedD1Workspace(d1, "ws_two");
  try {
    for (const store of [
      new InMemoryGitInstallPlanStore(memoryControl),
      new SqlGitInstallPlanStore(postgres),
      new D1GitInstallPlanStore(d1),
    ]) {
      await expectStoreParity(store);
    }
  } finally {
    await postgres.close();
  }
});

test("Git install-plan admission follows Workspace management state", async () => {
  const postgres = await PGliteSqlClient.create();
  const d1 = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(d1);
  const memoryControl = new InMemoryOpenTofuControlStore();
  const activeWorkspace = workspace("admission_ws");
  await memoryControl.putWorkspace(activeWorkspace);
  await seedPostgresWorkspace(postgres, activeWorkspace.id);
  await seedD1Workspace(d1, activeWorkspace.id);
  const authority: WorkspaceManagementAuthority = {
    workspaceId: activeWorkspace.id,
    managementState: "active",
    managementEpoch: 1,
  };
  await expect(
    new InMemoryGitInstallPlanStore().create({
      ...plan("admission_without_validator", "admission_without_validator"),
    }),
  ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
  const adapters: readonly {
    readonly label: string;
    readonly store: GitInstallPlanStore;
    readonly stop: () => Promise<void>;
  }[] = [
    {
      label: "memory",
      store: new InMemoryGitInstallPlanStore(memoryControl),
      stop: async () => {
        await memoryControl.beginWorkspaceDraining(activeWorkspace.id, authority);
      },
    },
    {
      label: "postgres",
      store: new SqlGitInstallPlanStore(postgres),
      stop: async () => {
        await postgres.query(
          `update takosumi_workspaces
              set management_state = 'draining', management_epoch = 2
            where id = $1`,
          [activeWorkspace.id],
        );
      },
    },
    {
      label: "d1",
      store: new D1GitInstallPlanStore(d1),
      stop: async () => {
        await d1
          .prepare(
            `update workspaces
                set management_state = 'draining', management_epoch = 2
              where id = ?`,
          )
          .bind(activeWorkspace.id)
          .run();
      },
    },
  ];
  try {
    for (const { label, store, stop } of adapters) {
      const base = {
        ...plan(`admission_${label}`, "admission_digest"),
        workspaceId: activeWorkspace.id,
        workspaceManagementAuthority: authority,
      };
      await expect(
        store.create({
          ...base,
          id: `${base.id}_missing_workspace`,
          workspaceId: `${base.id}_missing_workspace`,
          workspaceManagementAuthority: {
            ...authority,
            workspaceId: `${base.id}_missing_workspace`,
          },
          idempotencyKeyHash: `${base.id}_missing_workspace_key`,
        }),
      ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      await expect(
        store.create(
          { ...base, id: `${base.id}_malformed_authority` },
          { ...authority, managementEpoch: 0 },
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(await store.create(base, authority)).toMatchObject({
        status: "created",
      });
      const busy = {
        ...base,
        id: `${base.id}_busy`,
        idempotencyKeyHash: `${base.id}_busy_key`,
      };
      const fresh = {
        ...base,
        id: `${base.id}_fresh`,
        idempotencyKeyHash: `${base.id}_fresh_key`,
      };
      expect(await store.create(busy, authority)).toMatchObject({
        status: "created",
      });
      expect(await store.create(fresh, authority)).toMatchObject({
        status: "created",
      });
      const claim = await store.claimReconcile({
        id: base.id,
        expectedGeneration: 0,
        leaseToken: `lease_${base.id}`,
        claimedAt: "2026-08-21T00:01:00.000Z",
        leaseExpiresAt: "2026-08-21T00:01:30.000Z",
        expectedWorkspaceManagementAuthority: authority,
      });
      expect(claim.status).toBe("claimed");
      if (claim.status !== "claimed") throw new Error("claim was not acquired");
      const busyClaim = await store.claimReconcile({
        id: busy.id,
        expectedGeneration: 0,
        leaseToken: `lease_${busy.id}`,
        claimedAt: "2026-08-21T00:01:00.000Z",
        leaseExpiresAt: "2026-08-21T00:01:30.000Z",
        expectedWorkspaceManagementAuthority: authority,
      });
      expect(busyClaim.status).toBe("claimed");
      await expect(
        store.claimReconcile({
          id: busy.id,
          expectedGeneration: 1,
          leaseToken: "malformed",
          claimedAt: "2026-08-21T00:01:01.000Z",
          leaseExpiresAt: "2026-08-21T00:01:31.000Z",
          expectedWorkspaceManagementAuthority: {
            ...authority,
            managementEpoch: 0,
          },
        }),
      ).rejects.toBeInstanceOf(TypeError);

      await stop();

      // The lease acquired before draining may finish, but a fresh claim may
      // not start. Exact-scope reads and busy/generation observations remain
      // available while stopped.
      const completedPlan = {
        ...claim.claim.plan,
        phase: "compiling_install" as const,
        updatedAt: "2026-08-21T00:01:02.000Z",
      };
      expect(
        await store.completeReconcile({
          id: base.id,
          expectedGeneration: 1,
          leaseToken: claim.claim.leaseToken,
          plan: completedPlan,
        }),
      ).toMatchObject({ status: "completed", plan: { phase: "compiling_install" } });
      const scope = {
        workspaceId: base.workspaceId,
        actorSubject: base.actorSubject,
        idempotencyKeyHash: base.idempotencyKeyHash,
      };
      expect(await store.getByScope(scope)).toEqual(completedPlan);
      for (const otherScope of [
        { ...scope, workspaceId: `${scope.workspaceId}_other` },
        { ...scope, actorSubject: `${scope.actorSubject}_other` },
        { ...scope, idempotencyKeyHash: `${scope.idempotencyKeyHash}_other` },
      ]) {
        expect(await store.getByScope(otherScope)).toBeUndefined();
      }
      expect(await store.get(base.id)).toEqual(completedPlan);
      expect(
        await store.create({ ...base, id: `${base.id}_replay` }, authority),
      ).toMatchObject({ status: "replayed", plan: { id: base.id } });
      expect(
        await store.claimReconcile({
          id: busy.id,
          expectedGeneration: 1,
          leaseToken: "other",
          claimedAt: "2026-08-21T00:01:01.000Z",
          leaseExpiresAt: "2026-08-21T00:01:31.000Z",
        }),
      ).toMatchObject({ status: "busy", plan: { generation: 1 } });
      expect(
        await store.claimReconcile({
          id: base.id,
          expectedGeneration: 0,
          leaseToken: "stale",
          claimedAt: "2026-08-21T00:01:03.000Z",
          leaseExpiresAt: "2026-08-21T00:01:33.000Z",
        }),
      ).toMatchObject({ status: "conflict", plan: { generation: 1 } });

      await expect(
        store.create({
          ...base,
          id: `${base.id}_new`,
          idempotencyKeyHash: `${base.id}_new_key`,
        }, authority),
      ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);

      await expect(
        store.claimReconcile({
          id: fresh.id,
          expectedGeneration: 0,
          leaseToken: `lease_${fresh.id}`,
          claimedAt: "2026-08-21T00:01:04.000Z",
          leaseExpiresAt: "2026-08-21T00:01:34.000Z",
          expectedWorkspaceManagementAuthority: authority,
        }),
      ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    }
  } finally {
    await postgres.close();
  }
});

async function expectStoreParity(store: GitInstallPlanStore): Promise<void> {
  const first = {
    ...plan("ip_one", "digest_one"),
    workspaceManagementAuthority: {
      workspaceId: "ws_one",
      managementState: "active" as const,
      managementEpoch: 1,
    },
  };
  expect((await store.create(first)).status).toBe("created");
  const persisted = await store.get(first.id);
  expect(persisted).toEqual(first);
  expect(publicGitInstallPlan(persisted!)).not.toHaveProperty("workspaceManagementAuthority");

  await expect(store.create({
    ...first,
    id: "ip_missing_authority",
    idempotencyKeyHash: "missing_authority_key",
    workspaceManagementAuthority: undefined,
  }, first.workspaceManagementAuthority)).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
  await expect(store.create({
    ...first,
    id: "ip_stale_authority",
    idempotencyKeyHash: "stale_authority_key",
    workspaceManagementAuthority: { ...first.workspaceManagementAuthority, managementEpoch: 2 },
  })).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
  await expect(store.create({
    ...first,
    id: "ip_substituted_authority",
    idempotencyKeyHash: "substituted_authority_key",
    workspaceManagementAuthority: { ...first.workspaceManagementAuthority, managementEpoch: 2 },
  }, first.workspaceManagementAuthority)).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);

  const replay = await store.create({ ...first, id: "ip_replay" });
  expect(replay).toMatchObject({ status: "replayed", plan: { id: first.id } });

  const conflict = await store.create({
    ...first,
    id: "ip_conflict",
    requestDigest: "digest_two",
  });
  expect(conflict).toMatchObject({
    status: "conflict",
    plan: { id: first.id, requestDigest: "digest_one" },
  });
  expect(
    (
      await store.create({
        ...first,
        id: "ip_other_actor",
        createdBy: "user_two",
        actorSubject: "user_two",
      })
    ).status,
  ).toBe("created");
  expect(
    (
      await store.create({
        ...first,
        id: "ip_other_workspace",
        workspaceId: "ws_two",
        workspaceManagementAuthority: { ...first.workspaceManagementAuthority, workspaceId: "ws_two" },
      })
    ).status,
  ).toBe("created");

  await expect(store.claimReconcile({
    id: first.id,
    expectedGeneration: 0,
    leaseToken: "lease_wrong_authority",
    claimedAt: "2026-08-21T00:01:00.000Z",
    leaseExpiresAt: "2026-08-21T00:01:30.000Z",
    expectedWorkspaceManagementAuthority: { ...first.workspaceManagementAuthority, managementEpoch: 2 },
  })).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);

  const claim = await store.claimReconcile({
    id: first.id,
    expectedGeneration: 0,
    leaseToken: "lease_one",
    claimedAt: "2026-08-21T00:01:00.000Z",
    leaseExpiresAt: "2026-08-21T00:01:30.000Z",
  });
  expect(claim).toMatchObject({
    status: "claimed",
    claim: { plan: { generation: 1 } },
  });
  if (claim.status !== "claimed") throw new Error("claim was not acquired");

  await expect(
    store.completeReconcile({
      id: first.id,
      expectedGeneration: 1,
      leaseToken: "lease_one",
      plan: {
        ...claim.claim.plan,
        workspaceManagementAuthority: {
          ...first.workspaceManagementAuthority,
          managementEpoch: 2,
        },
      },
    }),
  ).rejects.toThrow("immutable request scope changed");

  await expect(
    store.completeReconcile({
      id: first.id,
      expectedGeneration: 1,
      leaseToken: "lease_one",
      plan: { ...claim.claim.plan, generation: 2 },
    }),
  ).rejects.toThrow("completion generation changed");
  await expect(
    store.completeReconcile({
      id: first.id,
      expectedGeneration: 1,
      leaseToken: "lease_one",
      plan: { ...claim.claim.plan, createdBy: "user_other" },
    }),
  ).rejects.toThrow("immutable request scope changed");

  expect(
    await store.claimReconcile({
      id: first.id,
      expectedGeneration: 0,
      leaseToken: "lease_stale",
      claimedAt: "2026-08-21T00:01:01.000Z",
      leaseExpiresAt: "2026-08-21T00:01:31.000Z",
    }),
  ).toMatchObject({ status: "conflict", plan: { generation: 1 } });

  const completedPlan: StoredGitInstallPlan = {
    ...claim.claim.plan,
    // JSONB may reorder object keys; immutable authority compares values.
    workspaceManagementAuthority: {
      managementEpoch: 1,
      managementState: "active",
      workspaceId: "ws_one",
    },
    phase: "compiling_install",
    sourceId: "src_one",
    updatedAt: "2026-08-21T00:01:02.000Z",
  };
  expect(
    await store.completeReconcile({
      id: first.id,
      expectedGeneration: 1,
      leaseToken: "lease_one",
      plan: completedPlan,
    }),
  ).toMatchObject({
    status: "completed",
    plan: {
      phase: "compiling_install",
      sourceId: "src_one",
      generation: 1,
    },
  });
  expect(await store.get(first.id)).toEqual(completedPlan);

  const revision = revisionPlan();
  expect((await store.create(revision)).status).toBe("created");
  const revisionClaim = await store.claimReconcile({
    id: revision.id,
    expectedGeneration: 0,
    leaseToken: "lease_revision",
    claimedAt: "2026-08-21T00:02:00.000Z",
    leaseExpiresAt: "2026-08-21T00:02:30.000Z",
  });
  if (revisionClaim.status !== "claimed") {
    throw new Error("revision claim was not acquired");
  }
  await expect(
    store.completeReconcile({
      id: revision.id,
      expectedGeneration: 1,
      leaseToken: "lease_revision",
      plan: {
        ...revisionClaim.claim.plan,
        capsuleId: "cap_wrong",
      },
    }),
  ).rejects.toThrow("immutable request scope changed");
}

test("retained Git rows stay observable without granting a new management claim", async () => {
  const postgres = await PGliteSqlClient.create();
  const d1 = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(d1);
  await seedPostgresWorkspace(postgres, "ws_one");
  await seedD1Workspace(d1, "ws_one");
  const adapters = [
    {
      store: new SqlGitInstallPlanStore(postgres),
      retainLegacy: async (value: StoredGitInstallPlan) => {
        await postgres.query(
          "update takosumi_git_install_plans set record_json = $1::jsonb where id = $2",
          [JSON.stringify(value), value.id],
        );
      },
      resume: async () => {
        await postgres.query("update takosumi_workspaces set management_state = 'active', management_epoch = 3 where id = 'ws_one'");
      },
    },
    {
      store: new D1GitInstallPlanStore(d1),
      retainLegacy: async (value: StoredGitInstallPlan) => {
        await d1.prepare("update git_install_plans set record_json = ? where id = ?")
          .bind(JSON.stringify(value), value.id).run();
      },
      resume: async () => {
        await d1.prepare("update workspaces set management_state = 'active', management_epoch = 3 where id = 'ws_one'").run();
      },
    },
  ];
  try {
    for (const { store, retainLegacy, resume } of adapters) {
      const pending = plan("legacy_pending", "legacy_pending");
      const held = { ...pending, id: "legacy_held", idempotencyKeyHash: "legacy_held" };
      const old = { ...pending, id: "old_epoch", idempotencyKeyHash: "old_epoch" };
      await store.create(pending);
      await store.create(held);
      await store.create(old);
      const claimInput = {
        expectedGeneration: 0,
        leaseToken: "held_lease",
        claimedAt: "2026-08-21T00:01:00.000Z",
        leaseExpiresAt: "2026-08-21T00:01:30.000Z",
      };
      const claim = await store.claimReconcile({ ...claimInput, id: held.id });
      if (claim.status !== "claimed") throw new Error("fixture claim was not acquired");
      // Fixture historical JSON emitted before the private field existed.
      // No runtime backfill or test-only store API is needed.
      const legacyPending = { ...pending, workspaceManagementAuthority: undefined };
      const legacyHeld = { ...claim.claim.plan, workspaceManagementAuthority: undefined };
      await retainLegacy(legacyPending);
      await retainLegacy(legacyHeld);
      expect(await store.get(pending.id)).toEqual(legacyPending);
      expect(await store.getByScope(pending)).toEqual(legacyPending);
      expect(await store.create(legacyPending)).toMatchObject({ status: "replayed" });
      await expect(store.claimReconcile({ ...claimInput, id: pending.id }))
        .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      await expect(store.claimReconcile({ ...claimInput, id: pending.id, expectedWorkspaceManagementAuthority: pending.workspaceManagementAuthority }))
        .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect(await store.claimReconcile({ ...claimInput, id: held.id, expectedGeneration: 1 }))
        .toMatchObject({ status: "busy" });
      expect(await store.claimReconcile({ ...claimInput, id: held.id }))
        .toMatchObject({ status: "conflict" });
      await expect(store.completeReconcile({
        id: held.id, expectedGeneration: 1, leaseToken: "held_lease",
        plan: { ...legacyHeld, workspaceManagementAuthority: pending.workspaceManagementAuthority },
      })).rejects.toThrow("immutable request scope changed");
      expect(await store.completeReconcile({
        id: held.id, expectedGeneration: 1, leaseToken: "held_lease",
        plan: { ...legacyHeld, phase: "failed", updatedAt: "2026-08-21T00:01:01.000Z" },
      })).toMatchObject({ status: "completed", plan: { phase: "failed" } });
      expect(await store.claimReconcile({ ...claimInput, id: "absent" }))
        .toEqual({ status: "not_found" });

      // A stopped-and-resumed Workspace is active again, but old work cannot
      // borrow its new epoch, even when the caller omits the optional guard.
      await resume();
      for (const expectedWorkspaceManagementAuthority of [undefined, {
        workspaceId: "ws_one", managementState: "active" as const, managementEpoch: 3,
      }]) {
        await expect(store.claimReconcile({ ...claimInput, id: old.id, expectedWorkspaceManagementAuthority }))
          .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      }
      expect(await store.get(old.id)).toEqual(old);
    }
  } finally {
    await postgres.close();
  }
});

test("Git install-plan blockers are Workspace-wide and terminal plans cannot be reclaimed", async () => {
  const postgres = await PGliteSqlClient.create();
  const d1 = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(d1);
  const memoryControl = new InMemoryOpenTofuControlStore();
  for (const workspaceId of [
    "ws_terminal",
    "ws_lease",
    "ws_unknown",
    "ws_mismatch",
    "ws_completion",
  ]) {
    await memoryControl.putWorkspace(workspace(workspaceId));
    await seedPostgresWorkspace(postgres, workspaceId);
    await seedD1Workspace(d1, workspaceId);
  }
  try {
    await exerciseWorkspaceBlockers(
      new InMemoryGitInstallPlanStore(memoryControl),
    );
    await exerciseWorkspaceBlockers(new SqlGitInstallPlanStore(postgres), {
      retainLease: async (id, token, expiresAt) => {
        await postgres.query(
          `update takosumi_git_install_plans
              set reconcile_lease_token = $1, reconcile_lease_expires_at = $2
            where id = $3`,
          [token, expiresAt, id],
        );
      },
      mutatePhase: async (id, phase) => {
        await postgres.query(
          `update takosumi_git_install_plans set phase = $1 where id = $2`,
          [phase, id],
        );
      },
      mutateRecord: async (id, recordJson) => {
        await postgres.query(
          `update takosumi_git_install_plans set record_json = $1::jsonb where id = $2`,
          [recordJson, id],
        );
      },
      mutateGeneration: async (id, generation) => {
        await postgres.query(
          `update takosumi_git_install_plans set generation = $1 where id = $2`,
          [generation, id],
        );
      },
    });
    await exerciseWorkspaceBlockers(new D1GitInstallPlanStore(d1), {
      retainLease: async (id, token, expiresAt) => {
        await d1
          .prepare(
            `update git_install_plans
                set reconcile_lease_token = ?, reconcile_lease_expires_at = ?
              where id = ?`,
          )
          .bind(token, expiresAt, id)
          .run();
      },
      mutatePhase: async (id, phase) => {
        await d1
          .prepare("update git_install_plans set phase = ? where id = ?")
          .bind(phase, id)
          .run();
      },
      mutateRecord: async (id, recordJson) => {
        await d1
          .prepare("update git_install_plans set record_json = ? where id = ?")
          .bind(recordJson, id)
          .run();
      },
      mutateGeneration: async (id, generation) => {
        await d1
          .prepare("update git_install_plans set generation = ? where id = ?")
          .bind(generation, id)
          .run();
      },
      mutateMalformed: async (id) => {
        await d1
          .prepare("update git_install_plans set record_json = ? where id = ?")
          .bind("not-json", id)
          .run();
      },
    });
  } finally {
    await postgres.close();
  }
});

test("Git blocker predicate fails closed when its aggregate result is indeterminate", async () => {
  const emptySqlClient: SqlClient = {
    query: async <Row extends Record<string, unknown>>() => ({
      rows: [] as Row[],
      rowCount: 0,
    }),
    transaction: async <T>(_fn: (transaction: SqlTransaction) => T | Promise<T>) => {
      throw new Error("not used");
    },
  };
  await expect(
    new SqlGitInstallPlanStore(emptySqlClient).hasWorkspaceManagementBlockers("ws"),
  ).rejects.toThrow("indeterminate");

  const invalidSqlClient: SqlClient = {
    query: async <Row extends Record<string, unknown>>() => ({
      rows: [{ present: 1 } as unknown as Row],
      rowCount: 1,
    }),
    transaction: async <T>(_fn: (transaction: SqlTransaction) => T | Promise<T>) => {
      throw new Error("not used");
    },
  };
  await expect(
    new SqlGitInstallPlanStore(invalidSqlClient).hasWorkspaceManagementBlockers("ws"),
  ).rejects.toThrow("indeterminate");

  type FakeD1Statement = {
    bind(...values: unknown[]): FakeD1Statement;
    first<T>(): Promise<T | null>;
    run<T = Record<string, unknown>>(): Promise<{ meta: { changes: number } }>;
  };
  const statement: FakeD1Statement = {
    bind: (..._values) => statement,
    first: async <T>() => null as T | null,
    run: async () => ({ meta: { changes: 0 } }),
  };
  const emptyD1 = { prepare: () => statement };
  await expect(
    new D1GitInstallPlanStore(emptyD1).hasWorkspaceManagementBlockers("ws"),
  ).rejects.toThrow("indeterminate");

  const invalidD1Statement: FakeD1Statement = {
    bind: (..._values) => invalidD1Statement,
    first: async <T>() => ({ present: 2 } as unknown as T),
    run: async () => ({ meta: { changes: 0 } }),
  };
  const invalidD1 = { prepare: () => invalidD1Statement };
  await expect(
    new D1GitInstallPlanStore(invalidD1).hasWorkspaceManagementBlockers("ws"),
  ).rejects.toThrow("indeterminate");
});

async function exerciseWorkspaceBlockers(
  store: GitInstallPlanStore,
  options: {
    readonly retainLease?: (
      id: string,
      token: string | null,
      expiresAt: string | null,
    ) => Promise<void>;
    readonly mutatePhase?: (id: string, phase: string) => Promise<void>;
    readonly mutateRecord?: (id: string, recordJson: string) => Promise<void>;
    readonly mutateGeneration?: (id: string, generation: number) => Promise<void>;
    readonly mutateMalformed?: (id: string) => Promise<void>;
  } = {},
): Promise<void> {
  const failed = {
    ...plan("blocker_failed", "blocker_failed_digest"),
    workspaceId: "ws_terminal",
    workspaceManagementAuthority: {
      workspaceId: "ws_terminal",
      managementState: "active" as const,
      managementEpoch: 1,
    },
    phase: "failed" as const,
  };
  const reviewable = {
    ...plan("blocker_reviewable", "blocker_reviewable_digest"),
    workspaceId: "ws_terminal",
    workspaceManagementAuthority: {
      workspaceId: "ws_terminal",
      managementState: "active" as const,
      managementEpoch: 1,
    },
    idempotencyKeyHash: "blocker_reviewable_key",
    phase: "reviewable" as const,
  };
  expect((await store.create(failed)).status).toBe("created");
  expect((await store.create(reviewable)).status).toBe("created");
  expect(await store.hasWorkspaceManagementBlockers("ws_terminal")).toBe(false);
  for (const terminal of [failed, reviewable]) {
    const result = await store.claimReconcile({
      id: terminal.id,
      expectedGeneration: 0,
      leaseToken: `${terminal.id}_lease`,
      claimedAt: "2026-08-21T00:01:00.000Z",
      leaseExpiresAt: "2026-08-21T00:01:30.000Z",
    });
    expect(result).toMatchObject({
      status: "conflict",
      plan: { id: terminal.id, phase: terminal.phase, generation: 0 },
    });
    expect(await store.get(terminal.id)).toEqual(terminal);
  }

  const retainedToken = {
    ...plan("blocker_retained_token", "blocker_retained_token_digest"),
    workspaceId: "ws_lease",
    workspaceManagementAuthority: {
      workspaceId: "ws_lease",
      managementState: "active" as const,
      managementEpoch: 1,
    },
    idempotencyKeyHash: "blocker_retained_token_key",
    phase: "failed" as const,
  };
  expect((await store.create(retainedToken)).status).toBe("created");
  if (options.retainLease) {
    await options.retainLease(
      retainedToken.id,
      "retained-token",
      "2020-01-01T00:00:00.000Z",
    );
    expect(await store.hasWorkspaceManagementBlockers("ws_lease")).toBe(true);
    expect(
      await store.claimReconcile({
        id: retainedToken.id,
        expectedGeneration: 0,
        leaseToken: "replacement",
        claimedAt: "2026-08-21T00:01:00.000Z",
        leaseExpiresAt: "2026-08-21T00:01:30.000Z",
      }),
    ).toMatchObject({ status: "conflict", plan: { generation: 0 } });
    await options.retainLease(retainedToken.id, null, null);
    expect(await store.hasWorkspaceManagementBlockers("ws_lease")).toBe(false);
    const retainedExpiry = {
      ...retainedToken,
      id: "blocker_retained_expiry",
      idempotencyKeyHash: "blocker_retained_expiry_key",
    };
    expect((await store.create(retainedExpiry)).status).toBe("created");
    await options.retainLease(
      retainedExpiry.id,
      null,
      "2020-01-01T00:00:00.000Z",
    );
    expect(await store.hasWorkspaceManagementBlockers("ws_lease")).toBe(true);
    await options.retainLease(retainedExpiry.id, null, null);
    expect(await store.hasWorkspaceManagementBlockers("ws_lease")).toBe(false);
  } else {
    expect(await store.hasWorkspaceManagementBlockers("ws_lease")).toBe(false);
  }
  expect(await store.hasWorkspaceManagementBlockers("ws_empty")).toBe(false);

  const unknown = {
    ...plan("blocker_unknown", "blocker_unknown_digest"),
    workspaceId: "ws_unknown",
    workspaceManagementAuthority: {
      workspaceId: "ws_unknown",
      managementState: "active" as const,
      managementEpoch: 1,
    },
    idempotencyKeyHash: "blocker_unknown_key",
    phase: "unknown" as never,
  };
  expect((await store.create(unknown)).status).toBe("created");
  expect(await store.hasWorkspaceManagementBlockers("ws_unknown")).toBe(true);
  expect(
    await store.claimReconcile({
      id: unknown.id,
      expectedGeneration: 0,
      leaseToken: "unknown_lease",
      claimedAt: "2026-08-21T00:01:00.000Z",
      leaseExpiresAt: "2026-08-21T00:01:30.000Z",
    }),
  ).toMatchObject({ status: "conflict", plan: { generation: 0 } });

  const mismatch = {
    ...plan("blocker_mismatch", "blocker_mismatch_digest"),
    workspaceId: "ws_mismatch",
    workspaceManagementAuthority: {
      workspaceId: "ws_mismatch",
      managementState: "active" as const,
      managementEpoch: 1,
    },
    idempotencyKeyHash: "blocker_mismatch_key",
    phase: "failed" as const,
  };
  expect((await store.create(mismatch)).status).toBe("created");
  if (options.mutatePhase) {
    await options.mutatePhase(mismatch.id, "reviewable");
    expect(await store.hasWorkspaceManagementBlockers("ws_mismatch")).toBe(true);
    expect(
      await store.claimReconcile({
        id: mismatch.id,
        expectedGeneration: 0,
        leaseToken: "mismatch_lease",
        claimedAt: "2026-08-21T00:01:00.000Z",
        leaseExpiresAt: "2026-08-21T00:01:30.000Z",
      }),
    ).toMatchObject({ status: "conflict", plan: { generation: 0 } });
    await options.mutatePhase(mismatch.id, "failed");
    expect(await store.hasWorkspaceManagementBlockers("ws_mismatch")).toBe(false);
    if (options.mutateRecord) {
      await options.mutateRecord(
        mismatch.id,
        JSON.stringify({ ...mismatch, workspaceId: "ws_other" }),
      );
      expect(await store.hasWorkspaceManagementBlockers("ws_mismatch")).toBe(true);
      await options.mutateRecord(mismatch.id, JSON.stringify(mismatch));
      expect(await store.hasWorkspaceManagementBlockers("ws_mismatch")).toBe(false);
    }
    if (options.mutateGeneration) {
      await options.mutateGeneration(mismatch.id, 1);
      expect(await store.hasWorkspaceManagementBlockers("ws_mismatch")).toBe(true);
      await options.mutateGeneration(mismatch.id, 0);
      expect(await store.hasWorkspaceManagementBlockers("ws_mismatch")).toBe(false);
    }
    if (options.mutateMalformed) {
      await options.mutateMalformed(mismatch.id);
      expect(await store.hasWorkspaceManagementBlockers("ws_mismatch")).toBe(true);
      await options.mutateRecord!(mismatch.id, JSON.stringify(mismatch));
      expect(await store.hasWorkspaceManagementBlockers("ws_mismatch")).toBe(false);
    }
  }

  const completion = {
    ...plan("blocker_completion", "blocker_completion_digest"),
    workspaceId: "ws_completion",
    workspaceManagementAuthority: {
      workspaceId: "ws_completion",
      managementState: "active" as const,
      managementEpoch: 1,
    },
    idempotencyKeyHash: "blocker_completion_key",
    phase: "planning" as const,
  };
  expect((await store.create(completion)).status).toBe("created");
  expect(await store.hasWorkspaceManagementBlockers("ws_completion")).toBe(true);
  const claim = await store.claimReconcile({
    id: completion.id,
    expectedGeneration: 0,
    leaseToken: "completion_lease",
    claimedAt: "2026-08-21T00:02:00.000Z",
    leaseExpiresAt: "2026-08-21T00:02:30.000Z",
  });
  if (claim.status !== "claimed") throw new Error("completion claim was not acquired");
  expect(
    await store.completeReconcile({
      id: completion.id,
      expectedGeneration: 1,
      leaseToken: claim.claim.leaseToken,
      plan: {
        ...claim.claim.plan,
        phase: "failed",
        updatedAt: "2026-08-21T00:02:01.000Z",
      },
    }),
  ).toMatchObject({ status: "completed", plan: { phase: "failed" } });
  expect(await store.hasWorkspaceManagementBlockers("ws_completion")).toBe(false);
}

function workspace(id: string): {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly type: "personal";
  readonly ownerUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
} {
  return {
    id,
    handle: `handle-${id}`,
    displayName: id,
    type: "personal",
    ownerUserId: `owner-${id}`,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

async function seedPostgresWorkspace(
  client: PGliteSqlClient,
  id: string,
): Promise<void> {
  const value = workspace(id);
  await client.query(
    `insert into takosumi_workspaces
      (id, handle, space_json, created_at, updated_at, management_state, management_epoch)
     values ($1, $2, $3::jsonb, $4, $5, 'active', 1)`,
    [
      value.id,
      value.handle,
      JSON.stringify(value),
      value.createdAt,
      value.updatedAt,
    ],
  );
}

async function seedD1Workspace(
  db: SqliteFakeD1,
  id: string,
): Promise<void> {
  const value = workspace(id);
  await db
    .prepare(
      `insert into workspaces
        (id, handle, record_json, created_at, updated_at, management_state, management_epoch)
       values (?, ?, ?, ?, ?, 'active', 1)`,
    )
    .bind(
      value.id,
      value.handle,
      JSON.stringify(value),
      value.createdAt,
      value.updatedAt,
    )
    .run();
}

function plan(id: string, requestDigest: string): StoredGitInstallPlan {
  return {
    id,
    workspaceId: "ws_one",
    workspaceManagementAuthority: { workspaceId: "ws_one", managementState: "active", managementEpoch: 1 },
    createdBy: "user_one",
    actorSubject: "user_one",
    idempotencyKeyHash: "key_hash_one",
    requestDigest,
    source: {
      name: "repo",
      url: "https://github.com/takos/example.git",
      ref: "main",
      path: ".",
    },
    capsule: { name: "example", environment: "production" },
    options: {},
    phase: "syncing_source",
    generation: 0,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

function revisionPlan(): StoredGitInstallPlan {
  return {
    ...plan("rp_one", "digest_revision"),
    idempotencyKeyHash: "key_hash_revision",
    operation: "revision",
    sourceId: "src_revision",
    capsuleId: "cap_revision",
    installConfigId: "cfg_revision",
    installConfigBaseId: "cfg_revision",
    installConfigBaseDigest: "sha256:config",
    installModulePath: ".",
    revision: {
      targetRef: "release/v2",
      base: {
        capsuleStateGeneration: 2,
        installConfigId: "cfg_revision",
        installConfigDigest: "sha256:config",
        sourceDefaultRef: "main",
        sourceDefaultPath: ".",
      },
    },
  };
}
