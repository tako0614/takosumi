import { afterEach, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Run } from "takosumi-contract/runs";
import type {
  Capsule,
  CapsuleCompatibilityReport,
} from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { SourceSyncRun } from "takosumi-contract/sources";

import type {
  SqlClient,
  SqlParameters,
} from "../../../../core/adapters/storage/sql.ts";
import {
  capsuleApplyRunAdmissionFence,
  createCapsuleExecutionAuthorityResolver,
  capsuleLifecycleExpected,
  InMemoryOpenTofuControlStore,
  WorkspaceManagementAdmissionConflictError,
  planRunExecutionInputsDigestMaterial,
  type StoredRunRecord,
  type WorkspaceManagementAuthority,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { D1GitInstallPlanStore } from "../../../../core/domains/install-plans/d1_store.ts";
import type { StoredGitInstallPlan } from "../../../../core/domains/install-plans/store.ts";
import {
  createD1InterfaceStores,
  InterfaceService,
} from "../../../../core/domains/interfaces/mod.ts";
import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import {
  PGliteSqlClient,
  splitSqlStatements,
} from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import { StaticSecretConnectionVault } from "../../../../core/adapters/vault/mod.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { REFERENCE_CREDENTIAL_RECIPE_COMPOSITION } from "../../../../providers/registry.ts";
import type {
  D1Database,
  D1PreparedStatement,
} from "../../../../worker/src/bindings.ts";

const NOW = "2026-08-10T00:00:00.000Z";
const WORKSPACE_ID = "workspace_authority";
const CAPSULE_ID = "capsule_authority";
const BATCH_CAPSULE_A = "capsule_authority_batch_a";
const BATCH_CAPSULE_B = "capsule_authority_batch_b";
const BATCH_CAPSULE_DESTROYED = "capsule_authority_batch_destroyed";
const BATCH_CAPSULE_UNSAFE = "capsule_authority_batch_unsafe";
const BATCH_CAPSULE_PRE_PROVIDER_FAILURE =
  "capsule_authority_batch_pre_provider_failure";
const clients: PGliteSqlClient[] = [];

interface RecordedQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

function recordingD1(
  database: D1Database,
  records: RecordedQuery[],
): D1Database {
  return {
    prepare(query) {
      const statement = database.prepare(query);
      const record = (parameters: readonly unknown[]) => {
        records.push({ sql: query, parameters });
      };
      return {
        bind(...values) {
          record(values);
          return statement.bind(...values);
        },
        first<T>() {
          record([]);
          return statement.first<T>();
        },
        all<T>() {
          record([]);
          return statement.all<T>();
        },
        run<T>() {
          record([]);
          return statement.run<T>();
        },
      } satisfies D1PreparedStatement;
    },
    batch: (statements) => database.batch(statements),
  };
}

function recordingSqlClient(
  client: SqlClient,
  records: RecordedQuery[],
): SqlClient {
  return {
    query(sql, parameters) {
      records.push({
        sql,
        parameters: Array.isArray(parameters) ? parameters : [],
      });
      return client.query(sql, parameters as SqlParameters | undefined);
    },
    transaction: (fn) => client.transaction(fn),
  };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function capsule(status: Capsule["status"] = "active"): Capsule {
  return {
    id: CAPSULE_ID,
    workspaceId: WORKSPACE_ID,
    projectId: "project_authority",
    name: "authority",
    slug: "authority",
    sourceId: "source_authority",
    installConfigId: "config_authority",
    environment: "production",
    currentStateGeneration: 0,
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function terminatingRun(status: "queued" | "failed"): ApplyRun {
  return {
    id: "run_authority_destroy",
    planRunId: "plan_authority_destroy",
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
    operation: "destroy",
    runnerProfileId: "opentofu-default",
    status,
    expected: {
      planRunId: "plan_authority_destroy",
      capsuleId: CAPSULE_ID,
      runnerProfileId: "opentofu-default",
      sourceDigest: "sha256:source",
      variablesDigest: "sha256:variables",
      policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan",
      planArtifactDigest: "sha256:plan",
    },
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "recorded", backendRef: "state" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: status === "queued" ? 1 : 2,
    startedAt: 1,
    ...(status === "failed" ? { finishedAt: 2 } : {}),
  };
}

function batchCapsule(
  capsuleId: string,
  status: Capsule["status"] = "active",
): Capsule {
  return {
    ...capsule(status),
    id: capsuleId,
    projectId: `project_${capsuleId}`,
    name: capsuleId,
    slug: capsuleId,
  };
}

function batchTerminatingRun(capsuleId: string): ApplyRun {
  const run = terminatingRun("queued");
  return {
    ...run,
    id: `run_destroy_${capsuleId}`,
    planRunId: `plan_destroy_${capsuleId}`,
    capsuleId,
    expected: {
      ...run.expected,
      planRunId: `plan_destroy_${capsuleId}`,
      capsuleId,
    },
  };
}

function batchPreProviderFailureRun(capsuleId: string): ApplyRun {
  const run = terminatingRun("failed");
  return {
    ...run,
    id: `run_init_failed_${capsuleId}`,
    planRunId: `plan_init_failed_${capsuleId}`,
    capsuleId,
    operation: "update",
    expected: {
      ...run.expected,
      planRunId: `plan_init_failed_${capsuleId}`,
      capsuleId,
    },
    auditEvents: [
      {
        id: `audit_init_failed_${capsuleId}`,
        type: "apply.failed",
        at: 2,
        data: { providerDispatched: true },
      },
    ],
    diagnostics: [
      {
        severity: "error",
        code: "opentofu_init_failed",
        message: "runner failure (opentofu_init_failed)",
      },
    ],
  };
}

const batchAuthorityInputs = [
  { workspaceId: WORKSPACE_ID, capsuleId: BATCH_CAPSULE_B },
  { workspaceId: WORKSPACE_ID, capsuleId: BATCH_CAPSULE_A },
  { workspaceId: WORKSPACE_ID, capsuleId: BATCH_CAPSULE_B },
  { workspaceId: WORKSPACE_ID, capsuleId: "capsule_authority_batch_missing" },
  { workspaceId: "workspace_foreign", capsuleId: BATCH_CAPSULE_A },
  { workspaceId: WORKSPACE_ID, capsuleId: BATCH_CAPSULE_DESTROYED },
  { workspaceId: WORKSPACE_ID, capsuleId: BATCH_CAPSULE_UNSAFE },
  {
    workspaceId: WORKSPACE_ID,
    capsuleId: BATCH_CAPSULE_PRE_PROVIDER_FAILURE,
  },
] as const;

const batchAuthorityExpected = [
  {
    workspaceId: WORKSPACE_ID,
    capsuleId: BATCH_CAPSULE_B,
    executionAuthorityEpoch: 1,
  },
  {
    workspaceId: WORKSPACE_ID,
    capsuleId: BATCH_CAPSULE_A,
    executionAuthorityEpoch: 1,
  },
  {
    workspaceId: WORKSPACE_ID,
    capsuleId: BATCH_CAPSULE_B,
    executionAuthorityEpoch: 1,
  },
  undefined,
  undefined,
  undefined,
  undefined,
  {
    workspaceId: WORKSPACE_ID,
    capsuleId: BATCH_CAPSULE_PRE_PROVIDER_FAILURE,
    executionAuthorityEpoch: 1,
  },
] as const;

async function seedBatchAuthorities(
  store: OpenTofuControlStore,
): Promise<void> {
  await store.putCapsule(batchCapsule(BATCH_CAPSULE_A));
  await store.putCapsule(batchCapsule(BATCH_CAPSULE_B));
  await store.putCapsule(batchCapsule(BATCH_CAPSULE_DESTROYED, "destroyed"));
  await store.putCapsule(batchCapsule(BATCH_CAPSULE_UNSAFE));
  await store.putApplyRun(batchTerminatingRun(BATCH_CAPSULE_UNSAFE));
  await store.putCapsule(batchCapsule(BATCH_CAPSULE_PRE_PROVIDER_FAILURE));
  await store.putApplyRun(
    batchPreProviderFailureRun(BATCH_CAPSULE_PRE_PROVIDER_FAILURE),
  );
}

async function expectBatchAuthorityParity(
  store: OpenTofuControlStore,
): Promise<void> {
  await seedBatchAuthorities(store);
  await expect(
    store.resolveCapsuleExecutionAuthorities(batchAuthorityInputs),
  ).resolves.toEqual(batchAuthorityExpected);
}

async function expectLifecycleParity(
  stores: readonly OpenTofuControlStore[],
): Promise<void> {
  const [first, second = first] = stores;
  if (!first || !second) throw new Error("authority stores are required");
  await first.putCapsule(capsule());

  await expect(
    first.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID),
  ).resolves.toEqual({
    workspaceId: WORKSPACE_ID,
    capsuleId: CAPSULE_ID,
    executionAuthorityEpoch: 1,
  });
  await expect(
    first.resolveCapsuleExecutionAuthority("workspace_foreign", CAPSULE_ID),
  ).resolves.toBeUndefined();

  await first.patchCapsule(CAPSULE_ID, { status: "stale", updatedAt: NOW });
  expect(
    (await first.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID))
      ?.executionAuthorityEpoch,
  ).toBe(1);

  await first.putApplyRun(terminatingRun("queued"));
  await expect(
    first.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID),
  ).resolves.toBeUndefined();
  await first.putApplyRun(terminatingRun("failed"));
  await expect(
    first.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID),
  ).resolves.toMatchObject({ executionAuthorityEpoch: 1 });

  // Two independently composed writers can observe a live row and race the
  // same terminal transition. The durable trigger/CAS consumes one epoch.
  await Promise.all([
    first.patchCapsule(CAPSULE_ID, { status: "destroyed", updatedAt: NOW }),
    second.patchCapsule(CAPSULE_ID, { status: "destroyed", updatedAt: NOW }),
  ]);
  await expect(
    first.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID),
  ).resolves.toBeUndefined();

  // A synthetic reactivation is not a product lifecycle operation, but proves
  // that retirement did not reset the private fence to its default.
  await first.patchCapsule(CAPSULE_ID, { status: "active", updatedAt: NOW });
  expect(
    (await first.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID))
      ?.executionAuthorityEpoch,
  ).toBe(2);

  await first.commitRunState({
    capsulePatch: {
      id: CAPSULE_ID,
      patch: { status: "destroyed", updatedAt: NOW },
      guard: { currentStateVersionId: undefined, status: "active" },
    },
  });
  await first.patchCapsule(CAPSULE_ID, { status: "active", updatedAt: NOW });
  expect(
    (await first.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID))
      ?.executionAuthorityEpoch,
  ).toBe(3);
}

async function expectInitiallyDestroyedDefault(
  store: OpenTofuControlStore,
): Promise<void> {
  await store.putCapsule(capsule("destroyed"));
  await store.patchCapsule(CAPSULE_ID, { status: "active", updatedAt: NOW });
  await expect(
    store.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID),
  ).resolves.toMatchObject({ executionAuthorityEpoch: 1 });
}

describe("Capsule execution authority", () => {
  test("InMemory keeps the same private terminal-transition semantics", async () => {
    const store = new InMemoryOpenTofuControlStore();
    await expectLifecycleParity([store]);
  });

  test("D1 converges terminal writers and commitRunState on one durable epoch", async () => {
    const database = new SqliteFakeD1();
    await expectLifecycleParity([
      new CloudflareD1OpenTofuControlStore(database),
      new CloudflareD1OpenTofuControlStore(database),
    ]);
  });

  test("Postgres converges terminal writers and commitRunState on one durable epoch", async () => {
    const client = await PGliteSqlClient.create();
    clients.push(client);
    await expectLifecycleParity([
      new SqlOpenTofuControlStore({ client }),
      new SqlOpenTofuControlStore({ client }),
    ]);
  });

  test("all stores keep the default epoch at one for an initially destroyed row", async () => {
    const client = await PGliteSqlClient.create();
    clients.push(client);
    await Promise.all([
      expectInitiallyDestroyedDefault(new InMemoryOpenTofuControlStore()),
      expectInitiallyDestroyedDefault(
        new CloudflareD1OpenTofuControlStore(new SqliteFakeD1()),
      ),
      expectInitiallyDestroyedDefault(new SqlOpenTofuControlStore({ client })),
    ]);
  });

  test("ordered batches preserve duplicates and fail closed across all stores", async () => {
    const client = await PGliteSqlClient.create();
    clients.push(client);
    await expectBatchAuthorityParity(new InMemoryOpenTofuControlStore());
    await expectBatchAuthorityParity(
      new CloudflareD1OpenTofuControlStore(new SqliteFakeD1()),
    );
    await expectBatchAuthorityParity(new SqlOpenTofuControlStore({ client }));
  });

  test("D1 resolves an ordered authority batch in one json_each statement", async () => {
    const records: RecordedQuery[] = [];
    const database = new SqliteFakeD1();
    const store = new CloudflareD1OpenTofuControlStore(
      recordingD1(database, records),
    );
    await seedBatchAuthorities(store);
    records.length = 0;

    await expect(
      store.resolveCapsuleExecutionAuthorities(batchAuthorityInputs),
    ).resolves.toEqual(batchAuthorityExpected);

    const authorityStatements = records.filter((record) =>
      record.sql.includes("ordered_capsule_authority_requests"),
    );
    expect(authorityStatements).toHaveLength(1);
    const [authorityStatement] = authorityStatements;
    if (!authorityStatement) throw new Error("D1 batch statement is missing");
    expect(authorityStatement.sql).toContain("json_each");
    expect(authorityStatement.parameters).toHaveLength(1);
    const plan = await database
      .prepare(`explain query plan ${authorityStatement.sql}`)
      .bind(...authorityStatement.parameters)
      .all<{ readonly detail: string }>();
    const details = (plan.results ?? []).map((row) => row.detail);
    expect(
      details.some((detail) =>
        detail.includes("capsules_execution_authority_exact_idx"),
      ),
    ).toBe(true);
    expect(
      details.some((detail) => detail.includes("runs_installation_idx")),
    ).toBe(true);
  });

  test("Workspace metadata and member guards execute on isolated workerd D1", async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-17",
      modules: [{ type: "ESModule", path: "workspace-writes.mjs", contents: "export default {fetch(){return new Response('ok')}}" }],
      d1Databases: { CONTROL: "workspace-writes" },
    });
    try {
      const database = await runtime.getD1Database("CONTROL") as unknown as D1Database;
      const store = new CloudflareD1OpenTofuControlStore(database);
      const service = new WorkspacesService({ store });
      const workspace = await service.createWorkspace({
        handle: "workspace-writes", displayName: "Original", type: "personal", ownerUserId: "owner",
      });
      const actor = await service.upsertWorkspaceMember({
        workspaceId: workspace.id, accountId: "admin", actorAccountId: "owner", roles: ["admin"],
      });
      const member = await service.upsertWorkspaceMember({
        workspaceId: workspace.id, accountId: "reader", actorAccountId: "admin", roles: ["member"],
      });
      const authority = await service.captureManagementAuthority(workspace.id);
      await store.putWorkspaceMember({ ...actor, status: "suspended" });
      expect(await store.replaceWorkspaceForAccount({
        workspace: { ...workspace, displayName: "Revoked admin" }, expectedWorkspace: workspace,
        expectedWorkspaceManagementAuthority: authority, actorAccountId: actor.accountId, expectedActor: actor,
      })).toBe(false);
      expect(await store.mutateWorkspaceMember({
        member: { ...member, roles: ["viewer"] }, expectedMember: member,
        expectedActor: actor, expectedWorkspace: workspace, expectedWorkspaceManagementAuthority: authority,
      })).toBe(false);
      expect(await store.getWorkspaceMember(workspace.id, member.accountId)).toEqual(member);
      const changed = await service.updateWorkspaceForAccount(workspace.id, { displayName: "Updated" }, "owner");
      expect(changed.displayName).toBe("Updated");
      expect(await store.replaceWorkspace({
        workspace: { ...workspace, displayName: "Stale" }, expectedWorkspace: workspace,
        expectedWorkspaceManagementAuthority: authority,
      })).toBe(false);
      await store.beginWorkspaceDraining(workspace.id, authority);
      await expect(service.upsertWorkspaceMember({
        workspaceId: workspace.id, accountId: "new-member", actorAccountId: "owner",
      })).rejects.toMatchObject({ code: "failed_precondition" });
      await expect(service.updateWorkspace(workspace.id, { displayName: "Stopped" }))
        .rejects.toMatchObject({ code: "failed_precondition" });
      await database.prepare("update workspaces set management_state = 'active', management_epoch = 3 where id = ?")
        .bind(workspace.id).run();
      await expect(store.replaceWorkspace({
        workspace: { ...changed, displayName: "Late" }, expectedWorkspace: changed,
        expectedWorkspaceManagementAuthority: authority,
      })).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect(await new CloudflareD1OpenTofuControlStore(database).getWorkspace(workspace.id)).toEqual(changed);
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  test("Connection registration rolls back a failed blob insert on isolated workerd D1", async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-17",
      modules: [{ type: "ESModule", path: "connection-registration.mjs", contents: "export default {fetch(){return new Response('ok')}}" }],
      d1Databases: { CONTROL: "connection-registration" },
    });
    try {
      const database = await runtime.getD1Database("CONTROL") as unknown as D1Database;
      const store = new CloudflareD1OpenTofuControlStore(database);
      const service = new WorkspacesService({ store });
      const workspace = await service.createWorkspace({ handle: "connection-registration",
        displayName: "Connections", type: "personal", ownerUserId: "owner" });
      let counter = 0;
      const vault = new StaticSecretConnectionVault({
        store, newId: () => `conn_registration_${++counter}`,
        crypto: new PartitionedSecretBoundaryCrypto({ globalPassphrase: "registration-fixture-passphrase-0123456789" }),
        credentialRecipeResolver: (id) => REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find((recipe) => recipe.id === id),
      });
      const registration = { workspaceId: workspace.id,
        provider: "registry.opentofu.org/vercel/vercel",
        credentialRecipe: { id: "generic-env", authMode: "env", secretPartition: "provider-credentials", declaredEnv: true },
        values: { VERCEL_API_TOKEN: "fixture-only-value" } };
      const first = await vault.register(registration, undefined, null);
      const firstBlob = await store.getSecretBlob(first.id);
      expect(firstBlob).toBeDefined();
      if (!firstBlob) throw new Error("registration fixture blob is missing");
      // The first table insert really executes. A database-side failure on
      // the second table must roll it back, not leave a credentialless row.
      await database.prepare("CREATE TRIGGER reject_registration_blob BEFORE INSERT ON secret_blobs BEGIN SELECT RAISE(ABORT, 'fixture blob write failure'); END").run();
      await expect(vault.register(registration, undefined, null)).rejects.toThrow();
      expect(await store.getConnection("conn_registration_2")).toBeUndefined();
      expect(await store.getSecretBlob("conn_registration_2")).toBeUndefined();
      expect(await store.getConnection(first.id)).toEqual(first);
      expect(await store.getSecretBlob(first.id)).toEqual(firstBlob);
      await database.prepare("DROP TRIGGER reject_registration_blob").run();

      const authority = await service.captureManagementAuthority(workspace.id);
      const candidate = { connection: { ...first, id: "conn_registration_stale" },
        secretBlob: { ...firstBlob, id: "secret_conn_registration_stale", connectionId: "conn_registration_stale" },
        expectedWorkspaceManagementAuthority: authority, actorAuthority: null };
      await store.beginWorkspaceDraining(workspace.id, authority);
      await expect(store.createConnectionRegistration(candidate)).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      await database.prepare("update workspaces set management_state = 'active', management_epoch = 3 where id = ?").bind(workspace.id).run();
      await expect(store.createConnectionRegistration(candidate)).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect(await store.getConnection(candidate.connection.id)).toBeUndefined();
      expect(await store.getSecretBlob(candidate.connection.id)).toBeUndefined();
      const fresh = await vault.register(registration, undefined, null);
      expect(await new CloudflareD1OpenTofuControlStore(database).getConnection(fresh.id)).toEqual(fresh);
      expect(await store.getSecretBlob(fresh.id)).toBeDefined();
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  test("Connection revocation rolls back a failed second delete on isolated workerd D1", async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-17",
      modules: [{ type: "ESModule", path: "connection-revoke.mjs", contents: "export default {fetch(){return new Response('ok')}}" }],
      d1Databases: { CONTROL: "connection-revoke" },
    });
    try {
      const database = await runtime.getD1Database("CONTROL") as unknown as D1Database;
      const store = new CloudflareD1OpenTofuControlStore(database);
      const service = new WorkspacesService({ store });
      const workspace = await service.createWorkspace({ handle: "connection-revoke", displayName: "Revoke",
        type: "personal", ownerUserId: "owner" });
      const vault = new StaticSecretConnectionVault({
        store, newId: () => "conn_revoke_workerd",
        crypto: new PartitionedSecretBoundaryCrypto({ globalPassphrase: "revocation-fixture-passphrase-0123456789" }),
        credentialRecipeResolver: (id) => REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find((recipe) => recipe.id === id),
      });
      const connection = await vault.register({ workspaceId: workspace.id,
        provider: "registry.opentofu.org/example/example",
        credentialRecipe: { id: "generic-env", authMode: "env", secretPartition: "provider-credentials" },
        values: { EXAMPLE_TOKEN: "fixture-only-value" } }, undefined, null);
      const blob = await store.getSecretBlob(connection.id);
      expect(blob).toBeDefined();
      await database.prepare("CREATE TRIGGER reject_revoke_connection BEFORE DELETE ON connections BEGIN SELECT RAISE(ABORT, 'fixture revoke failure'); END").run();
      await expect(vault.revoke(connection.id, undefined, null)).rejects.toThrow();
      const reopened = new CloudflareD1OpenTofuControlStore(database);
      expect(await reopened.getConnection(connection.id)).toEqual(connection);
      expect(await reopened.getSecretBlob(connection.id)).toEqual(blob);
      await database.prepare("DROP TRIGGER reject_revoke_connection").run();
      const original = await service.captureManagementAuthority(workspace.id);
      await store.beginWorkspaceDraining(workspace.id, original);
      await expect(vault.revoke(connection.id, original, null)).rejects.toMatchObject({ reason: "workspace_management_admission_conflict" });
      await database.prepare("update workspaces set management_state = 'active', management_epoch = 3 where id = ?").bind(workspace.id).run();
      await expect(vault.revoke(connection.id, original, null)).rejects.toMatchObject({ reason: "workspace_management_admission_conflict" });
      expect(await reopened.getSecretBlob(connection.id)).toEqual(blob);
      expect(await vault.revoke(connection.id, undefined, null)).toBe(true);
      expect(await reopened.getConnection(connection.id)).toBeUndefined();
      expect(await reopened.getSecretBlob(connection.id)).toBeUndefined();
      expect(await vault.revoke(connection.id, undefined, null)).toBe(false);
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  test("Connection actor revocation fences final writes on isolated workerd D1", async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-17",
      modules: [{ type: "ESModule", path: "connection-actor.mjs", contents: "export default {fetch(){return new Response('ok')}}" }],
      d1Databases: { CONTROL: "connection-actor" },
    });
    try {
      const database = await runtime.getD1Database("CONTROL") as unknown as D1Database;
      let beforeBatch: (() => Promise<void>) | undefined;
      const store = new CloudflareD1OpenTofuControlStore({
        prepare: (query) => database.prepare(query),
        async batch(statements) {
          const action = beforeBatch;
          beforeBatch = undefined;
          await action?.();
          return await database.batch(statements);
        },
      });
      const service = new WorkspacesService({ store });
      for (const operation of ["register", "test", "revoke"] as const) {
        const workspace = await service.createWorkspace({ handle: `actor-${operation}`, displayName: "Actor authority",
          type: "personal", ownerUserId: "owner" });
        const member = await service.upsertWorkspaceMember({ workspaceId: workspace.id,
          actorAccountId: "owner", accountId: "admin", roles: ["admin"] });
        const connectionId = `conn_actor_${operation}`;
        const vault = new StaticSecretConnectionVault({
          store, newId: () => connectionId,
          crypto: new PartitionedSecretBoundaryCrypto({ globalPassphrase: "actor-fixture-passphrase-0123456789" }),
          credentialRecipeResolver: (id) => REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find((recipe) => recipe.id === id),
        });
        const registration = { workspaceId: workspace.id, provider: "registry.opentofu.org/example/example",
          credentialRecipe: { id: "generic-env", authMode: "env", secretPartition: "provider-credentials" },
          values: { EXAMPLE_TOKEN: "fixture-only-value" } };
        if (operation !== "register") await vault.register(registration, undefined, "admin");
        const originalConnection = await store.getConnection(connectionId);
        const originalBlob = await store.getSecretBlob(connectionId);
        const authority = await service.captureManagementAuthority(workspace.id);
        let interleavedOnce = false;
        beforeBatch = async () => {
          interleavedOnce = true;
          await store.putWorkspaceMember({ ...member, status: "suspended" });
        };
        const result = operation === "register" ? vault.register(registration, authority, "admin")
          : operation === "test" ? vault.test(connectionId, authority, "admin")
          : vault.revoke(connectionId, authority, "admin");
        await expect(result).rejects.toMatchObject({ code: "failed_precondition" });
        expect(interleavedOnce).toBe(true);
        const reopened = new CloudflareD1OpenTofuControlStore(database);
        expect(await reopened.getConnection(connectionId)).toEqual(originalConnection);
        expect(await reopened.getSecretBlob(connectionId)).toEqual(originalBlob);
        expect(await reopened.getWorkspaceManagement(workspace.id)).toEqual(authority);
        expect(await reopened.getWorkspaceMember(workspace.id, "admin")).toMatchObject({ status: "suspended" });
      }
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  test("Connection test results fence in-batch races on isolated workerd D1", async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-17",
      modules: [{ type: "ESModule", path: "connection-test.mjs", contents: "export default {fetch(){return new Response('ok')}}" }],
      d1Databases: { CONTROL: "connection-test" },
    });
    try {
      const database = await runtime.getD1Database("CONTROL") as unknown as D1Database;
      let beforeBatch: (() => Promise<void>) | undefined;
      const interleaved: D1Database = {
        prepare: (query) => database.prepare(query),
        async batch(statements) {
          const action = beforeBatch;
          beforeBatch = undefined;
          await action?.();
          return await database.batch(statements);
        },
      };
      const store = new CloudflareD1OpenTofuControlStore(interleaved);
      const service = new WorkspacesService({ store });
      for (const mutation of ["rotate", "absence", "physical", "drain", "resume"] as const) {
        const workspace = await service.createWorkspace({ handle: `test-${mutation}`, displayName: "Test result",
          type: "personal", ownerUserId: "owner" });
        const vault = new StaticSecretConnectionVault({
          store, newId: () => `conn_test_workerd_${mutation}`,
          crypto: new PartitionedSecretBoundaryCrypto({ globalPassphrase: "test-result-fixture-passphrase-0123456789" }),
          credentialRecipeResolver: (id) => REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find((recipe) => recipe.id === id),
        });
        let connection = await vault.register({ workspaceId: workspace.id,
          provider: "registry.opentofu.org/example/example",
          credentialRecipe: { id: "generic-env", authMode: "env", secretPartition: "provider-credentials" },
          values: { EXAMPLE_TOKEN: "fixture-only-value" } }, undefined, null);
        const blob = (await store.getSecretBlob(connection.id))!;
        if (mutation === "absence") {
          await store.deleteSecretBlob(connection.id);
          connection = { ...connection, secretPartition: undefined };
          await store.putConnection(connection);
        }
        const original = await service.captureManagementAuthority(workspace.id);
        let interleavedOnce = false;
        beforeBatch = async () => {
          interleavedOnce = true;
          if (mutation === "rotate") await store.putSecretBlob({ ...blob, ciphertext: "cm90YXRlZA==" });
          else if (mutation === "absence") await store.putSecretBlob(blob);
          else if (mutation === "physical") {
            await database.prepare("update connections set status = 'verified' where id = ?").bind(connection.id).run();
          } else {
            await store.beginWorkspaceDraining(workspace.id, original);
            if (mutation === "resume") {
              await database.prepare("update workspaces set management_state = 'active', management_epoch = 3 where id = ?").bind(workspace.id).run();
            }
          }
        };
        const result = store.commitConnectionTestResult({ expectedConnection: connection,
          expectedSecretBlob: mutation === "absence" ? null : blob,
          replacement: { ...connection, status: "verified", verifiedAt: connection.updatedAt },
          expectedWorkspaceManagementAuthority: original, actorAuthority: null });
        if (mutation === "drain" || mutation === "resume") {
          await expect(result).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
        } else {
          expect(await result).toBe(false);
        }
        expect(interleavedOnce).toBe(true);
        const reopened = new CloudflareD1OpenTofuControlStore(database);
        expect(await reopened.getConnection(connection.id)).toEqual(connection);
        expect(await reopened.getSecretBlob(connection.id)).toEqual(
          mutation === "rotate" ? { ...blob, ciphertext: "cm90YXRlZA==" } : blob,
        );
      }
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  test("Run claims, approvals and continuation markers require their original epoch in the final workerd D1 update", async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-17",
      modules: [{ type: "ESModule", path: "run-management.mjs", contents: "export default {fetch(){return new Response('ok')}}" }],
      d1Databases: { CONTROL: "run-management" },
    });
    try {
      const database = await runtime.getD1Database("CONTROL") as unknown as D1Database;
      let beforeClaim: (() => Promise<void>) | undefined;
      const store = new CloudflareD1OpenTofuControlStore({
        prepare(query) {
          const statement = database.prepare(query);
          if (!beforeClaim || !/^\s*update\s+"?(?:runs|capsules)"?\s/iu.test(query)) return statement;
          const wrap = (bound: D1PreparedStatement): D1PreparedStatement => ({
            bind: (...values) => wrap(bound.bind(...values)),
            first: <T>() => bound.first<T>(),
            all: <T>() => bound.all<T>(),
            async run<T>() {
              const action = beforeClaim;
              beforeClaim = undefined;
              await action?.();
              return await bound.run<T>();
            },
          });
          return wrap(statement);
        },
        batch: (statements) => database.batch(statements),
      });
      for (const kind of ["plan", "apply", "restore"] as const) {
        const workspaceId = `workerd-run-${kind}`;
        await store.putWorkspace({ id: workspaceId, handle: workspaceId, displayName: "Run management",
          type: "personal", ownerUserId: "owner", createdAt: NOW, updatedAt: NOW });
        const original = { workspaceId, managementState: "active" as const, managementEpoch: 1 };
        const id = `workerd-${kind}`;
        let queued: StoredRunRecord;
        if (kind === "restore") {
          queued = { id, workspaceId, type: "restore", status: "queued", createdAt: NOW,
            createdBy: "owner", capsuleId: CAPSULE_ID, backupId: "backup", planDigest: "sha256:backup",
            restoreStateGeneration: 1, restoredFromStateVersionId: "state-1" } satisfies Run;
        } else if (kind === "apply") {
          const { startedAt: _startedAt, ...neverStarted } = terminatingRun("queued");
          const {
            capsuleId: _capsuleId,
            expected: {
              capsuleId: _expectedCapsuleId,
              ...headlessExpected
            },
            ...headlessRun
          } = neverStarted;
          queued = {
            ...headlessRun,
            id,
            workspaceId,
            operation: "update",
            expected: headlessExpected,
          } satisfies ApplyRun;
        } else {
          queued = { id, workspaceId, source: { kind: "git", url: "https://example.test/repo.git",
            commit: "0123456789abcdef0123456789abcdef01234567" }, sourceDigest: "sha256:source",
            operation: "update", runnerProfileId: "runner", status: "queued", createdAt: 1, updatedAt: 1,
            variablesDigest: await stableJsonDigest({}), executionInputsDigest: await stableJsonDigest(
              planRunExecutionInputsDigestMaterial({ planRunId: id, variables: {} }, undefined)),
            requiredProviders: [], requiredProviderRequirements: [], policy: { status: "passed", reasons: [], checkedAt: 1 },
            policyDecisionDigest: "sha256:policy", auditEvents: [] } satisfies PlanRun;
        }
        const admit = (authority: WorkspaceManagementAuthority) => kind === "plan"
          ? store.preparePlanRun({ run: queued as PlanRun, inputs: { planRunId: id, variables: {} },
              expectedWorkspaceManagementAuthority: authority })
          : kind === "apply" ? store.beginApplyRun(queued as ApplyRun, authority)
          : store.beginRestoreRun(queued as Run, authority);
        expect((await admit(original)).status).toBe("created");
        const wrongOwner = { ...queued, workspaceId: `${workspaceId}-other` };
        await expect(kind === "plan" ? store.putPlanRun(wrongOwner as PlanRun)
          : kind === "apply" ? store.putApplyRun(wrongOwner as ApplyRun)
          : store.putBackupRun(wrongOwner as Run)).rejects.toThrow();
        if (kind === "plan") {
          const ownerCapsule = { ...capsule(), id: "workerd-plan-terminal", workspaceId };
          await store.putCapsule(ownerCapsule);
          const state = { id: "workerd-plan-terminal-state", workspaceId, capsuleId: ownerCapsule.id,
            environment: ownerCapsule.environment, generation: 1, stateRef: "fixture-state",
            digest: "sha256:fixture", createdByRunId: id, createdAt: NOW };
          const refused = await store.commitRunState({
            stateVersion: state,
            capsulePatch: { id: ownerCapsule.id, patch: { currentStateGeneration: 1, currentStateVersionId: state.id },
              guard: { currentStateVersionId: undefined } },
            planRunApplied: { ...wrongOwner, status: "succeeded" } as PlanRun,
          }).then((result) => result.applyRunLeaseLost === true, () => true);
          expect(refused).toBe(true);
          expect(await store.getStateVersion(state.id)).toBeUndefined();
          expect(await store.getCapsule(ownerCapsule.id)).toEqual(ownerCapsule);
        }
        const running = { ...queued, status: "running", startedAt: kind === "restore" ? NOW : 100 } as StoredRunRecord;
        let interleaved = false;
        beforeClaim = async () => {
          interleaved = true;
          await store.beginWorkspaceDraining(workspaceId, original);
          await database.prepare("update workspaces set management_state = 'active', management_epoch = 3 where id = ?")
            .bind(workspaceId).run();
        };
        expect(await store.transitionRun({ id, kind, expectFrom: ["queued"], setLeaseToken: "stale-lease", run: running }))
          .toEqual({ won: false, run: queued });
        expect(interleaved).toBe(true);
        const reopened = new CloudflareD1OpenTofuControlStore(database);
        expect(await reopened.getRunManagementAuthority({ id, workspaceId, kind })).toEqual(original);
        expect(await reopened.transitionRun({ id, kind, expectFrom: ["queued"], setLeaseToken: "current-caller-lease",
          expectedWorkspaceManagementAuthority: { ...original, managementEpoch: 3 }, run: running }))
          .toEqual({ won: false, run: queued });
        expect(await database.prepare(
          "select json_extract(run_json, '$.workspaceManagementAuthority.managementEpoch') as epoch from runs where id = ?",
        ).bind(id).first()).toEqual({ epoch: 1 });
        expect(JSON.stringify(await reopened.listRunsByWorkspace(workspaceId))).not.toContain("workspaceManagementAuthority");
        if (kind !== "apply") {
          const approvalId = `${id}-approval`;
          const approvalAuthority = { ...original, managementEpoch: 3 };
          let approvalRun: PlanRun | Run;
          if (kind === "plan") {
            const inputs = { planRunId: approvalId, variables: {} };
            const initial: PlanRun = { ...queued as PlanRun, id: approvalId,
              executionInputsDigest: await stableJsonDigest(planRunExecutionInputsDigestMaterial(inputs, undefined)) };
            await store.preparePlanRun({ run: initial, inputs,
              expectedWorkspaceManagementAuthority: approvalAuthority });
            approvalRun = { ...initial, status: "waiting_approval" };
            await store.putPlanRun(approvalRun);
          } else {
            approvalRun = { ...queued as Run, id: approvalId, status: "waiting_approval" };
            await store.beginRestoreRun(approvalRun, approvalAuthority);
          }
          const approved = { ...approvalRun, status: kind === "plan" ? "succeeded" : "queued" } as PlanRun | Run;
          let approvalInterleaved = false;
          beforeClaim = async () => {
            approvalInterleaved = true;
            await store.beginWorkspaceDraining(workspaceId, approvalAuthority);
            await database.prepare("update workspaces set management_state = 'active', management_epoch = 5 where id = ?")
              .bind(workspaceId).run();
          };
          expect(await store.transitionRun({ id: approvalId, kind, expectFrom: ["waiting_approval"],
            requireStoredManagementAuthority: true, run: approved })).toEqual({ won: false, run: approvalRun });
          expect(approvalInterleaved).toBe(true);
          expect(await reopened.transitionRun({ id: approvalId, kind, expectFrom: ["waiting_approval"],
            requireStoredManagementAuthority: true,
            expectedWorkspaceManagementAuthority: { ...original, managementEpoch: 5 }, run: approved }))
            .toEqual({ won: false, run: approvalRun });
          expect(await database.prepare(
            "select json_extract(run_json, '$.workspaceManagementAuthority.managementEpoch') as epoch from runs where id = ?",
          ).bind(approvalId).first()).toEqual({ epoch: 3 });
        }
      }
      const workspaceId = "workerd-continuation-marker";
      await store.putWorkspace({ id: workspaceId, handle: workspaceId, displayName: "Continuation marker",
        type: "personal", ownerUserId: "owner", createdAt: NOW, updatedAt: NOW });
      const original = { workspaceId, managementState: "active" as const, managementEpoch: 1 };
      const stale = { ...capsule("stale"), id: "workerd-continuation-capsule", workspaceId,
        projectId: "workerd-continuation-project", autoUpdate: true };
      await store.putCapsule(stale);
      let markerInterleaved = false;
      beforeClaim = async () => {
        markerInterleaved = true;
        await store.beginWorkspaceDraining(workspaceId, original);
        await database.prepare("update workspaces set management_state = 'active', management_epoch = 3 where id = ?")
          .bind(workspaceId).run();
      };
      expect((await store.updateCapsuleLifecycle({
        capsuleId: stale.id,
        expected: capsuleLifecycleExpected(stale, 1),
        mutation: { kind: "auto-update-claim", sourceSnapshotId: "old-epoch-snapshot",
          expectedWorkspaceManagementAuthority: original },
        updatedAt: NOW,
      })).kind).toBe("conflict");
      expect(markerInterleaved).toBe(true);
      const reopened = new CloudflareD1OpenTofuControlStore(database);
      expect(await reopened.getCapsule(stale.id)).toEqual(stale);
      expect(await reopened.getWorkspaceManagement(workspaceId)).toEqual({ ...original, managementEpoch: 3 });
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  test("runtime-secret retirement ordered markers on isolated workerd D1", async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-17",
      modules: [{
        type: "ESModule",
        path: "runtime-secret-retirement-workerd.mjs",
        contents: "export default {fetch(){return new Response('ok')}}",
      }],
      d1Databases: { CONTROL: "runtime-secret-retirement-workerd" },
    });
    try {
      const database = await runtime.getD1Database("CONTROL") as unknown as D1Database;
      const store = new CloudflareD1OpenTofuControlStore(database);
      const run: ApplyRun = {
        ...terminatingRun("failed"),
        id: "workerd-runtime-secret-retirement",
        planRunId: "workerd-runtime-secret-retirement-plan",
        auditEvents: [
          {
            id: "workerd-runtime-secret-retirement-pending-before",
            type: "runtime_secret.retirement.pending",
            at: 100,
            data: {
              capsuleId: CAPSULE_ID,
              providerDestroyCommitted: true,
            },
          },
          {
            id: "workerd-runtime-secret-retirement-completed-before",
            type: "runtime_secret.retirement.completed",
            at: 110,
          },
          {
            id: "workerd-runtime-secret-retirement-pending-after",
            type: "runtime_secret.retirement.pending",
            at: 120,
            data: {
              capsuleId: CAPSULE_ID,
              providerDestroyCommitted: true,
            },
          },
          {
            id: "workerd-runtime-secret-retirement-unrelated",
            type: "apply.note",
            at: 130,
          },
          {
            id: "workerd-runtime-secret-retirement-deferred",
            type: "runtime_secret.retirement.deferred",
            at: 140,
          },
        ],
      };
      await store.putApplyRun(run);

      const staleBeforeMs = 1_000;
      expect(
        (
          await store.listPendingRuntimeSecretRetirementRuns({
            staleBeforeMs,
          })
        ).map((candidate) => candidate.id),
      ).toContain(run.id);
      expect(
        await store.claimPendingRuntimeSecretRetirementDispatch({
          runId: run.id,
          staleBeforeMs,
          attemptedAt: 200,
        }),
      ).toBe(true);

      const claimed = await store.getApplyRun(run.id);
      expect(claimed).toBeDefined();
      expect(
        (
          await store.listPendingRuntimeSecretRetirementRuns({
            staleBeforeMs,
          })
        ).map((candidate) => candidate.id),
      ).toContain(run.id);

      await store.putApplyRun({
        ...claimed!,
        updatedAt: 300,
        auditEvents: [
          ...claimed!.auditEvents,
          {
            id: "workerd-runtime-secret-retirement-completed-after",
            type: "runtime_secret.retirement.completed",
            at: 300,
          },
        ],
      });
      expect(
        (
          await store.listPendingRuntimeSecretRetirementRuns({
            staleBeforeMs,
          })
        ).map((candidate) => candidate.id),
      ).not.toContain(run.id);
      expect(
        await store.claimPendingRuntimeSecretRetirementDispatch({
          runId: run.id,
          staleBeforeMs,
          attemptedAt: 400,
        }),
      ).toBe(false);
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  test("terminal Apply finalizers preserve ordered billing and retirement markers on isolated workerd D1", async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-17",
      modules: [{
        type: "ESModule",
        path: "terminal-apply-finalizers-workerd.mjs",
        contents: "export default {fetch(){return new Response('ok')}}",
      }],
      d1Databases: { CONTROL: "terminal-apply-finalizers-workerd" },
    });
    try {
      const database = await runtime.getD1Database("CONTROL") as unknown as D1Database;
      const store = new CloudflareD1OpenTofuControlStore(database);
      const r0: ApplyRun = {
        ...terminatingRun("failed"),
        id: "workerd-terminal-apply-finalizers",
        planRunId: "workerd-terminal-apply-finalizers-plan",
        auditEvents: [
          {
            id: "workerd-terminal-apply-billing-pending",
            type: "billing.capture.pending",
            at: 100,
            data: {
              planRunId: "workerd-terminal-apply-finalizers-plan",
              providerMutationCommitted: true,
            },
          },
          {
            id: "workerd-terminal-apply-retirement-pending",
            type: "runtime_secret.retirement.pending",
            at: 101,
            data: {
              capsuleId: CAPSULE_ID,
              installConfigId: "terminal-apply-finalizers-config",
              profileDigest: "sha256:terminal-apply-finalizers",
              providerDestroyCommitted: true,
            },
          },
        ],
      };
      await store.putApplyRun(r0);

      const billingCompleted: ApplyRun = {
        ...r0,
        auditEvents: [
          ...r0.auditEvents,
          {
            id: "workerd-terminal-apply-billing-completed",
            type: "billing.capture.completed",
            at: 200,
            data: {
              planRunId: r0.planRunId,
              applyRunId: r0.id,
            },
          },
        ],
      };
      expect(
        await store.transitionRun({
          id: r0.id,
          kind: "apply",
          expectFrom: [r0.status],
          expectExactRun: r0,
          run: billingCompleted,
        }),
      ).toEqual({ won: true, run: billingCompleted });

      const staleRetirement = {
        ...r0,
        auditEvents: [
          ...r0.auditEvents,
          {
            id: "workerd-terminal-apply-retirement-completed-stale",
            type: "runtime_secret.retirement.completed",
            at: 201,
            data: {
              capsuleId: CAPSULE_ID,
              installConfigId: "terminal-apply-finalizers-config",
              profileDigest: "sha256:terminal-apply-finalizers",
            },
          },
        ],
      } satisfies ApplyRun;
      expect(
        await store.transitionRun({
          id: r0.id,
          kind: "apply",
          expectFrom: [r0.status],
          expectExactRun: r0,
          run: staleRetirement,
        }),
      ).toEqual({ won: false, run: billingCompleted });

      const completed = {
        ...billingCompleted,
        auditEvents: [
          ...billingCompleted.auditEvents,
          {
            id: "workerd-terminal-apply-retirement-completed",
            type: "runtime_secret.retirement.completed",
            at: 202,
            data: {
              capsuleId: CAPSULE_ID,
              installConfigId: "terminal-apply-finalizers-config",
              profileDigest: "sha256:terminal-apply-finalizers",
            },
          },
        ],
      } satisfies ApplyRun;
      expect(
        await store.transitionRun({
          id: r0.id,
          kind: "apply",
          expectFrom: [billingCompleted.status],
          expectExactRun: billingCompleted,
          run: completed,
        }),
      ).toEqual({ won: true, run: completed });

      const staleDeferred = {
        ...r0,
        auditEvents: [
          ...r0.auditEvents,
          {
            id: "workerd-terminal-apply-retirement-deferred-stale",
            type: "runtime_secret.retirement.deferred",
            at: 203,
          },
        ],
      } satisfies ApplyRun;
      expect(
        await store.transitionRun({
          id: r0.id,
          kind: "apply",
          expectFrom: [r0.status],
          expectExactRun: r0,
          run: staleDeferred,
        }),
      ).toEqual({ won: false, run: completed });
      expect(await store.getApplyRun(r0.id)).toEqual(completed);
      expect(
        completed.auditEvents.map((event) => event.type),
      ).toEqual([
        "billing.capture.pending",
        "runtime_secret.retirement.pending",
        "billing.capture.completed",
        "runtime_secret.retirement.completed",
      ]);
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  test("ordered authority batches execute on an isolated workerd D1", async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-17",
      modules: [
        {
          type: "ESModule",
          path: "capsule-execution-authority-workerd.mjs",
          contents: "export default {fetch(){return new Response('ok')}}",
        },
      ],
      d1Databases: { CONTROL: "capsule-execution-authority-workerd" },
    });
    try {
      const database = await runtime.getD1Database("CONTROL");
      const store = new CloudflareD1OpenTofuControlStore(
        database as unknown as D1Database,
      );
      await expectBatchAuthorityParity(store);
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  test("Source management fences execute on isolated workerd D1 without blocking the current lease", async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-17",
      modules: [{
        type: "ESModule",
        path: "source-management-workerd.mjs",
        contents: "export default {fetch(){return new Response('ok')}}",
      }],
      d1Databases: { CONTROL: "source-management-workerd" },
    });
    try {
      const database = await runtime.getD1Database("CONTROL") as unknown as D1Database;
      const store = new CloudflareD1OpenTofuControlStore(database);
      await store.putWorkspace({
        id: WORKSPACE_ID,
        handle: "source-management",
        displayName: "Source management",
        type: "personal",
        ownerUserId: "source-management-owner",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const authority = {
        workspaceId: WORKSPACE_ID,
        managementState: "active" as const,
        managementEpoch: 1,
      };
      const stale = { ...capsule("stale"), autoUpdate: true };
      await store.putCapsule(stale);
      const project = {
        id: "project_management_native", workspaceId: WORKSPACE_ID,
        name: "Native project", slug: "native-project", projectJson: {},
        createdAt: NOW, updatedAt: NOW,
      };
      await expect(store.createProjectRecord({ project, expectedWorkspaceManagementAuthority: { ...authority, managementEpoch: 2 } }))
        .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect((await store.createProjectRecord({ project, expectedWorkspaceManagementAuthority: authority })).status).toBe("created");
      const source = {
        id: "source-management-source", workspaceId: WORKSPACE_ID,
        name: "source-kept", url: "https://example.com/source.git",
        defaultRef: "main", defaultPath: ".", status: "active" as const,
        hookSecretHash: "hash-kept", autoSync: false,
        createdAt: NOW, updatedAt: NOW,
      };
      await expect(store.writeSourceConfiguration({ source, expectedWorkspaceManagementAuthority: { ...authority, managementEpoch: 2 } }))
        .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect((await store.writeSourceConfiguration({ source, expectedWorkspaceManagementAuthority: authority })).status).toBe("created");
      const initial = {
        installConfig: {
          id: "config_initial_native", workspaceId: WORKSPACE_ID, name: "initial",
          variableMapping: {}, outputAllowlist: {}, policy: {}, createdAt: NOW, updatedAt: NOW,
        },
        capsule: {
          ...capsule("pending"), id: "capsule_initial_native", name: "initial-native", slug: "initial-native",
          sourceId: source.id, installConfigId: "config_initial_native",
        },
        providerBindingSet: {
          id: "binding_initial_native", workspaceId: WORKSPACE_ID, capsuleId: "capsule_initial_native",
          environment: "production", bindings: [], createdAt: NOW, updatedAt: NOW,
        },
        expectedWorkspaceManagementAuthority: authority,
      };
      expect((await store.createCapsuleInitialAuthority(initial)).status).toBe("created");
      const queued = {
        id: "source-management-run",
        kind: "source_sync",
        workspaceId: WORKSPACE_ID,
        sourceId: "source-management-source",
        url: "https://example.com/source.git",
        ref: "main",
        path: ".",
        archiveRef: "source-management-archive",
        snapshotId: "source-management-snapshot",
        status: "queued",
        createdAt: NOW,
        updatedAt: NOW,
      } satisfies SourceSyncRun;
      expect((await store.beginSourceSyncRun(queued, authority)).status).toBe("created");
      expect(await store.getSourceSyncRun(queued.id)).toEqual(queued);
      const delayed = { ...queued, id: "source-management-delayed" };
      expect(await store.beginSourceSyncRun(delayed, authority)).toEqual({ status: "created", run: delayed });
      const running = { ...queued, status: "running" as const };
      expect((await store.transitionRun({
        id: queued.id,
        kind: "source_sync",
        expectFrom: ["queued"],
        setLeaseToken: "source-management-lease",
        run: running,
      })).won).toBe(true);
      expect((await store.beginWorkspaceDraining(WORKSPACE_ID, authority)).status).toBe("started");
      expect(await store.createProjectRecord({ project })).toEqual({ status: "replayed", project });
      await expect(store.createProjectRecord({ project: { ...project, id: "project_native_denied", slug: "denied" } }))
        .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect(await store.getProject("project_native_denied")).toBeUndefined();
      expect((await store.createCapsuleInitialAuthority(initial)).status).toBe("replayed");
      await expect(store.writeSourceConfiguration({ source: { ...source, name: "after-drain" }, expectedSource: source }))
        .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      await expect(store.createCapsuleInitialAuthority({
        installConfig: { ...initial.installConfig, id: "config_initial_denied" },
        capsule: { ...initial.capsule, id: "capsule_initial_denied", name: "denied", slug: "denied", installConfigId: "config_initial_denied" },
        providerBindingSet: { ...initial.providerBindingSet, id: "binding_initial_denied", capsuleId: "capsule_initial_denied" },
      })).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect(await store.getCapsule("capsule_initial_denied")).toBeUndefined();
      expect(await store.getInstallConfig("config_initial_denied")).toBeUndefined();
      expect(await store.getProviderBindingSetByCapsule("capsule_initial_denied", "production")).toBeUndefined();
      expect(await store.beginSourceSyncRun(queued, authority)).toMatchObject({
        status: "existing",
        run: { status: "running" },
      });
      await expect(store.beginSourceSyncRun({ ...queued, id: "new-source-management-run" }))
        .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect(await store.getSourceSyncRun("new-source-management-run")).toBeUndefined();
      expect((await store.transitionRun({
        id: queued.id,
        kind: "source_sync",
        expectFrom: ["running"],
        expectedWorkspaceManagementAuthority: authority,
        clearLeaseToken: true,
        run: { ...running, status: "failed" },
      })).won).toBe(false);
      expect((await store.updateCapsuleLifecycle({
        capsuleId: CAPSULE_ID,
        expected: capsuleLifecycleExpected(stale, 1),
        mutation: { kind: "auto-update-claim", sourceSnapshotId: queued.snapshotId,
          expectedWorkspaceManagementAuthority: authority },
        updatedAt: NOW,
      })).kind).toBe("conflict");
      expect((await store.getCapsule(CAPSULE_ID))?.autoUpdateAttemptSourceSnapshotId).toBeUndefined();
      expect((await store.transitionRun({
        id: queued.id,
        kind: "source_sync",
        expectFrom: ["running"],
        expectLeaseToken: "source-management-lease",
        run: running,
      })).won).toBe(true);
      expect((await store.commitSourceSyncSuccess({
        terminalRun: {
          ...running, status: "succeeded", resolvedCommit: "native-commit",
          archiveDigest: "sha256:native", archiveSizeBytes: 128, finishedAt: NOW,
        },
        leaseToken: "source-management-lease",
        snapshot: {
          id: queued.snapshotId, origin: "git", workspaceId: WORKSPACE_ID, sourceId: source.id,
          url: queued.url, ref: queued.ref, path: queued.path, resolvedCommit: "native-commit",
          archiveRef: queued.archiveRef, archiveDigest: "sha256:native", archiveSizeBytes: 128,
          fetchedByRunId: queued.id, fetchedAt: NOW,
          repositoryInstallMetadata: { status: "absent" },
          repositoryManifest: { status: "absent" },
          repositoryModules: { status: "ready", scopePath: ".", modules: [] },
        },
      })).won).toBe(true);
      expect(await store.getSource(source.id)).toEqual({ ...source, lastSeenCommit: "native-commit" });
      // SourceSync terminal writes retain private original admission metadata
      // in the existing durable row, without exposing it from typed getters.
      expect(await database.prepare(
        "select json_extract(run_json, '$.workspaceManagementAuthority.managementEpoch') as epoch from runs where id = ?",
      ).bind(queued.id).first()).toEqual({ epoch: 1 });
      expect(JSON.stringify(await store.getSourceSyncRun(queued.id))).not.toContain("workspaceManagementAuthority");
      await database.prepare(
        "update workspaces set management_state = 'active', management_epoch = 3 where id = ? and management_state = 'draining'",
      ).bind(WORKSPACE_ID).run();
      const resumed = new CloudflareD1OpenTofuControlStore(database);
      const currentAuthority = { ...authority, managementEpoch: 3 };
      expect(await resumed.getWorkspaceManagement(WORKSPACE_ID)).toEqual(currentAuthority);
      expect(await resumed.getRunManagementAuthority({ id: queued.id, workspaceId: WORKSPACE_ID, kind: "source_sync" }))
        .toEqual(authority);
      for (const expectedWorkspaceManagementAuthority of [undefined, currentAuthority]) {
        expect(await resumed.transitionRun({
          id: delayed.id, kind: "source_sync", expectFrom: ["queued"],
          run: { ...delayed, status: "running" }, setLeaseToken: "delayed-lease",
          expectedWorkspaceManagementAuthority,
        })).toEqual({ won: false, run: delayed });
      }
      const fresh = { ...queued, id: "source-management-fresh" };
      expect(await resumed.beginSourceSyncRun(fresh, currentAuthority)).toEqual({ status: "created", run: fresh });
      expect(await resumed.transitionRun({
        id: fresh.id, kind: "source_sync", expectFrom: ["queued"],
        run: { ...fresh, status: "running" }, setLeaseToken: "fresh-lease",
      })).toEqual({ won: true, run: { ...fresh, status: "running" } });
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  test("Compatibility settlement rolls back the report when its terminal Run update fails on isolated workerd D1", async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-17",
      modules: [{
        type: "ESModule",
        path: "compatibility-settlement-workerd.mjs",
        contents: "export default {fetch(){return new Response('ok')}}",
      }],
      d1Databases: { CONTROL: "compatibility-settlement-workerd" },
    });
    try {
      const database = await runtime.getD1Database("CONTROL") as unknown as D1Database;
      const store = new CloudflareD1OpenTofuControlStore(database);
      const workspaceId = "compatibility-settlement-workerd";
      await store.putWorkspace({
        id: workspaceId,
        handle: "compatibility-settlement-workerd",
        displayName: "Compatibility settlement",
        type: "personal",
        ownerUserId: "compatibility-owner",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const authority: WorkspaceManagementAuthority = {
        workspaceId,
        managementState: "active",
        managementEpoch: 1,
      };
      const running: Run = {
        id: "compatibility-settlement-workerd-run",
        workspaceId,
        sourceId: "compatibility-settlement-workerd-source",
        type: "compatibility_check",
        status: "running",
        sourceSnapshotId: "compatibility-settlement-workerd-snapshot",
        createdBy: "compatibility-owner",
        createdAt: NOW,
        startedAt: NOW,
      };
      expect(await store.beginCompatibilityCheckRun(running, authority)).toEqual({
        status: "created",
        run: running,
      });
      expect(await store.beginWorkspaceDraining(workspaceId, authority)).toMatchObject({
        status: "started",
        management: {
          managementState: "draining",
          managementEpoch: 2,
        },
      });

      const report: CapsuleCompatibilityReport = {
        id: "compatibility-settlement-workerd-report",
        sourceId: running.sourceId!,
        sourceSnapshotId: running.sourceSnapshotId!,
        modulePath: ".",
        level: "ready",
        findings: [],
        providerPackages: [],
        rootProviderRequirements: [],
        resources: [],
        dataSources: [],
        provisioners: [],
        rootModuleVariables: [],
        rootModuleVariableDeclarations: [],
        rootModuleOutputs: [],
        createdAt: "2026-08-10T00:00:01.000Z",
      };
      const terminal: Run = {
        ...running,
        status: "succeeded",
        compatibilityReportId: report.id,
        finishedAt: "2026-08-10T00:00:02.000Z",
      };
      const input = {
        expectedRunningRun: running,
        terminalRun: terminal,
        report,
      };

      // The report INSERT precedes the terminal Run UPDATE in the settlement
      // batch. A real D1 trigger failure must roll back that pair atomically.
      await database.prepare(
        `CREATE TRIGGER reject_compatibility_terminal_update
           BEFORE UPDATE OF status ON runs
           WHEN OLD.id = 'compatibility-settlement-workerd-run'
             AND NEW.status = 'succeeded'
           BEGIN
             SELECT RAISE(ABORT, 'fixture compatibility terminal update failure');
           END`,
      ).run();
      await expect(store.commitCompatibilityCheckRun(input)).rejects.toThrow(
        "fixture compatibility terminal update failure",
      );
      const afterFailure = new CloudflareD1OpenTofuControlStore(database);
      expect(await afterFailure.getCompatibilityCheckRun(running.id)).toEqual(running);
      expect(await afterFailure.getCapsuleCompatibilityReport(report.id)).toBeUndefined();

      await database.prepare("DROP TRIGGER reject_compatibility_terminal_update").run();
      const reopened = new CloudflareD1OpenTofuControlStore(database);
      const committed = await reopened.commitCompatibilityCheckRun(input);
      expect(committed).toEqual({ status: "committed", run: terminal, report });
      expect(await reopened.getCompatibilityCheckRun(running.id)).toEqual(terminal);
      expect(await reopened.getCapsuleCompatibilityReport(report.id)).toEqual(report);

      // The captured original authority remains the replay fence while the
      // Workspace is draining; an exact payload may be reopened, not rewritten.
      expect(await reopened.commitCompatibilityCheckRun(input)).toEqual({
        status: "replayed",
        run: terminal,
        report,
      });
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  test("workerd D1 freeze validates Plan environment projection and approval settlement", async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-17",
      modules: [{
        type: "ESModule",
        path: "workspace-freeze-plan-workerd.mjs",
        contents: "export default {fetch(){return new Response('ok')}}",
      }],
      d1Databases: { CONTROL: "workspace-freeze-plan-workerd" },
    });
    try {
      const database = await runtime.getD1Database("CONTROL") as unknown as D1Database;
      const store = new CloudflareD1OpenTofuControlStore(database);
      const workspace = (id: string) => ({
        id, handle: id, displayName: "Freeze Plan", type: "personal" as const,
        ownerUserId: "freeze-owner", createdAt: NOW, updatedAt: NOW,
      });
      const planRun = (id: string, workspaceId: string): PlanRun => ({
        id,
        workspaceId,
        capsuleId: `capsule-${id}`,
        capsuleContext: {
          workspaceId,
          capsuleId: `capsule-${id}`,
          environment: "production",
        },
        source: {
          kind: "git",
          url: "https://example.test/freeze-plan.git",
          commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        sourceDigest: "sha256:source",
        operation: "update",
        runnerProfileId: "opentofu-default",
        variablesDigest: "sha256:variables",
        executionInputsDigest: "sha256:inputs",
        requiredProviders: [],
        status: "queued",
        policy: { status: "passed", reasons: [], checkedAt: 1 },
        policyDecisionDigest: "sha256:policy",
        requiresApproval: true,
        auditEvents: [],
        createdAt: 1,
        updatedAt: 1,
      });

      const legacyWorkspaceId = "workerd-freeze-legacy-plan";
      await store.putWorkspace(workspace(legacyWorkspaceId));
      const legacy = {
        ...planRun("workerd-freeze-legacy", legacyWorkspaceId),
        capsuleId: undefined,
        capsuleContext: undefined,
        status: "succeeded" as const,
      } satisfies PlanRun;
      await store.putPlanRun(legacy);
      const legacyAuthority: WorkspaceManagementAuthority = {
        workspaceId: legacyWorkspaceId,
        managementState: "active",
        managementEpoch: 1,
      };
      expect(await store.beginWorkspaceDraining(legacyWorkspaceId, legacyAuthority)).toMatchObject({
        status: "started",
        management: { managementState: "draining", managementEpoch: 2 },
      });
      const legacyDraining = {
        workspaceId: legacyWorkspaceId,
        managementState: "draining" as const,
        managementEpoch: 2,
      };
      expect(await store.freezeWorkspaceManagementIfQuiescent(legacyDraining)).toEqual({
        status: "blocked",
        management: legacyDraining,
      });

      const workspaceId = "workerd-freeze-canonical-plan";
      const plan = planRun("workerd-freeze-canonical", workspaceId);
      if (!plan.capsuleId) throw new Error("freeze plan fixture Capsule is missing");
      const seeded = await seedCapsuleModel(store, {
        workspaceId,
        capsuleId: plan.capsuleId,
        sourceId: "workerd-freeze-canonical-source",
        snapshotId: "workerd-freeze-canonical-snapshot",
        installConfigId: "workerd-freeze-canonical-config",
      });
      await store.putWorkspace(workspace(workspaceId));
      const authority: WorkspaceManagementAuthority = {
        workspaceId,
        managementState: "active",
        managementEpoch: 1,
      };
      const inputs = { planRunId: plan.id, variables: {} };
      expect(await store.preparePlanRun({
        run: plan,
        inputs,
        expectedWorkspaceManagementAuthority: authority,
      })).toEqual({ status: "created", run: plan });
      const running: PlanRun = { ...plan, status: "running", startedAt: 2, updatedAt: 2 };
      expect(await store.transitionRun({
        id: plan.id,
        kind: "plan",
        expectFrom: ["queued"],
        setLeaseToken: "freeze-plan-lease",
        run: running,
      })).toEqual({ won: true, run: running });
      const settled: PlanRun = {
        ...running,
        status: "succeeded",
        finishedAt: 3,
        approval: { approvedBy: "freeze-owner", approvedAt: 3 },
        updatedAt: 3,
      };
      expect(await store.transitionRun({
        id: plan.id,
        kind: "plan",
        expectFrom: ["running"],
        expectLeaseToken: "freeze-plan-lease",
        clearLeaseToken: true,
        requireStoredManagementAuthority: true,
        run: settled,
      })).toEqual({ won: true, run: settled });
      expect(await database.prepare(
        "select environment, json_extract(run_json, '$.capsuleContext.environment') as context_environment from runs where id = ?",
      ).bind(plan.id).first()).toEqual({
        environment: "production",
        context_environment: "production",
      });

      const git = new D1GitInstallPlanStore(database);
      const queuedApply: ApplyRun = {
        id: "workerd-freeze-queued-apply",
        planRunId: plan.id,
        workspaceId,
        capsuleId: plan.capsuleId,
        operation: "update",
        runnerProfileId: plan.runnerProfileId,
        status: "queued",
        expected: {
          planRunId: plan.id,
          capsuleId: plan.capsuleId,
          currentStateVersionId: null,
          runnerProfileId: plan.runnerProfileId,
          sourceDigest: plan.sourceDigest,
          variablesDigest: plan.variablesDigest,
          policyDecisionDigest: plan.policyDecisionDigest,
          planDigest: "sha256:freeze-plan",
          planArtifactDigest: "sha256:freeze-artifact",
        },
        stateBackend: { kind: "managed", ref: "state" } as never,
        stateLock: { status: "pending", backendRef: "state" },
        auditEvents: [],
        createdAt: 4,
        updatedAt: 4,
      };
      expect(
        await store.beginApplyRun(
          queuedApply,
          authority,
          capsuleApplyRunAdmissionFence(
            seeded.capsule,
            await store.getCapsuleExecutionAuthorityEpoch(seeded.capsule.id) ?? 1,
          ),
        ),
      ).toEqual({
        status: "created",
        run: queuedApply,
      });
      const queuedSourceSync: SourceSyncRun = {
        id: "workerd-freeze-queued-source-sync",
        kind: "source_sync",
        workspaceId,
        sourceId: "workerd-freeze-source",
        url: "https://example.test/freeze-source.git",
        ref: "main",
        path: ".",
        archiveRef: "workerd-freeze-source-archive",
        intent: "observe",
        status: "queued",
        createdAt: NOW,
        updatedAt: NOW,
        snapshotId: "workerd-freeze-source-snapshot",
      };
      expect(await store.beginSourceSyncRun(queuedSourceSync, authority)).toEqual({
        status: "created",
        run: queuedSourceSync,
      });
      const waitingRestore: Run = {
        id: "workerd-freeze-waiting-restore",
        workspaceId,
        capsuleId: plan.capsuleId,
        environment: "production",
        type: "restore",
        status: "waiting_approval",
        backupId: "workerd-freeze-restore-backup",
        restoreStateGeneration: 1,
        restoredFromStateVersionId: "workerd-freeze-restore-source-state",
        planDigest: "sha256:freeze-restore-plan",
        createdBy: "freeze-owner",
        createdAt: NOW,
      };
      expect(await store.beginRestoreRun(waitingRestore, authority)).toEqual({
        status: "created",
        run: waitingRestore,
      });
      const unclaimedGitPlan: StoredGitInstallPlan = {
        id: "workerd-freeze-unclaimed-git",
        workspaceId,
        workspaceManagementAuthority: authority,
        createdBy: "freeze-owner",
        actorSubject: "freeze-owner",
        idempotencyKeyHash: "workerd-freeze-git-idempotency",
        requestDigest: "workerd-freeze-git-request",
        source: {
          name: "freeze-git",
          url: "https://example.test/freeze-git.git",
          ref: "main",
          path: ".",
        },
        capsule: { name: "freeze-git", environment: "production" },
        options: {},
        phase: "syncing_source",
        generation: 0,
        createdAt: NOW,
        updatedAt: NOW,
      };
      expect((await git.create(unclaimedGitPlan, authority)).status).toBe("created");

      expect(await store.beginWorkspaceDraining(workspaceId, authority)).toMatchObject({
        status: "started",
        management: { managementState: "draining", managementEpoch: 2 },
      });
      const draining = {
        workspaceId,
        managementState: "draining" as const,
        managementEpoch: 2,
      };
      expect(await store.freezeWorkspaceManagementIfQuiescent(draining)).toEqual({
        status: "blocked",
        management: draining,
      });
      const cancelledApply: ApplyRun = {
        ...queuedApply,
        status: "cancelled",
        auditEvents: [{
          id: `${queuedApply.id}:apply.cancelled:5`,
          type: "apply.cancelled",
          at: 5,
        }],
        updatedAt: 5,
        finishedAt: 5,
      };
      expect(await store.transitionRun({
        id: queuedApply.id,
        kind: "apply",
        expectFrom: ["queued"],
        expectStartedAt: null,
        clearLeaseToken: true,
        expectDrainSettlement: {
          management: draining,
          expectedRun: queuedApply,
        },
        run: cancelledApply,
      })).toEqual({ won: true, run: cancelledApply });
      expect(await store.getApplyRun(queuedApply.id)).toEqual(cancelledApply);
      // The Git coordinator remains the blocker after the queued Apply settles.
      expect(await store.freezeWorkspaceManagementIfQuiescent(draining)).toEqual({
        status: "blocked",
        management: draining,
      });
      const failedSourceSync: SourceSyncRun = {
        ...queuedSourceSync,
        status: "failed",
        errorCode: "workspace_management_draining",
        error: "Workspace management stopped before this source sync was started.",
        updatedAt: "2026-08-10T00:00:03.000Z",
        finishedAt: "2026-08-10T00:00:03.000Z",
      };
      expect(await store.transitionRun({
        id: queuedSourceSync.id,
        kind: "source_sync",
        expectFrom: ["queued"],
        expectStartedAt: null,
        clearLeaseToken: true,
        expectDrainSettlement: {
          management: draining,
          expectedRun: queuedSourceSync,
        },
        run: failedSourceSync,
      })).toEqual({ won: true, run: failedSourceSync });
      expect(await store.getSourceSyncRun(queuedSourceSync.id)).toEqual(failedSourceSync);
      // Restore selection fields are immutable creation identity; drain settlement
      // appends only the terminal status and timestamp.
      const cancelledRestore: Run = {
        ...waitingRestore,
        status: "cancelled",
        finishedAt: "2026-08-10T00:00:04.000Z",
      };
      expect(await store.transitionRun({
        id: waitingRestore.id,
        kind: "restore",
        expectFrom: ["waiting_approval"],
        expectStartedAt: null,
        clearLeaseToken: true,
        expectDrainSettlement: {
          management: draining,
          expectedRun: waitingRestore,
        },
        run: cancelledRestore,
      })).toEqual({ won: true, run: cancelledRestore });
      expect(await store.getBackupRun(waitingRestore.id)).toEqual(cancelledRestore);
      expect(await store.freezeWorkspaceManagementIfQuiescent(draining)).toEqual({
        status: "blocked",
        management: draining,
      });
      const failedGit = await git.failUnclaimedDuringDrain({
        id: unclaimedGitPlan.id,
        expectedWorkspaceManagement: draining,
        completedAt: "2026-08-10T00:00:04.000Z",
      });
      expect(failedGit).toMatchObject({
        status: "completed",
        plan: {
          id: unclaimedGitPlan.id,
          workspaceId,
          workspaceManagementAuthority: authority,
          phase: "failed",
          generation: 0,
          diagnostic: { code: "workspace_management_draining" },
          completedAt: "2026-08-10T00:00:04.000Z",
        },
      });
      expect(await git.get(unclaimedGitPlan.id)).toMatchObject({
        ...unclaimedGitPlan,
        phase: "failed",
        workspaceManagementAuthority: authority,
        generation: 0,
        diagnostic: { code: "workspace_management_draining" },
        completedAt: "2026-08-10T00:00:04.000Z",
        updatedAt: "2026-08-10T00:00:04.000Z",
      });
      expect(await store.freezeWorkspaceManagementIfQuiescent(draining)).toEqual({
        status: "frozen",
        management: { ...draining, managementState: "frozen" },
      });
      const fresh = planRun("workerd-freeze-fresh", workspaceId);
      await expect(store.preparePlanRun({
        run: fresh,
        inputs: { planRunId: fresh.id, variables: {} },
      })).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      const stale = planRun("workerd-freeze-stale", workspaceId);
      await expect(store.preparePlanRun({
        run: stale,
        inputs: { planRunId: stale.id, variables: {} },
        expectedWorkspaceManagementAuthority: authority,
      })).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  test("Git, InstallConfig and Interface admission share the Workspace fence on isolated workerd D1", async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-17",
      modules: [{
        type: "ESModule",
        path: "git-interface-management-workerd.mjs",
        contents: "export default {fetch(){return new Response('ok')}}",
      }],
      d1Databases: { CONTROL: "git-interface-management-workerd" },
    });
    try {
      const database = await runtime.getD1Database("CONTROL") as unknown as D1Database;
      const management = new CloudflareD1OpenTofuControlStore(database);
      await management.putWorkspace({
        id: WORKSPACE_ID,
        handle: "git-interface-management",
        displayName: "Git and Interface management",
        type: "personal",
        ownerUserId: "management-owner",
        createdAt: NOW,
        updatedAt: NOW,
      });
      const authority = {
        workspaceId: WORKSPACE_ID,
        managementState: "active" as const,
        managementEpoch: 1,
      };
      const git = new D1GitInstallPlanStore(database);
      const plan: StoredGitInstallPlan = {
        id: "git-management-plan",
        workspaceId: WORKSPACE_ID,
        workspaceManagementAuthority: authority,
        createdBy: "management-owner",
        actorSubject: "management-owner",
        idempotencyKeyHash: "management-request-hash",
        requestDigest: "management-request-digest",
        source: {
          name: "repo",
          url: "https://example.com/source.git",
          ref: "main",
          path: ".",
        },
        capsule: { name: "management", environment: "production" },
        options: {},
        phase: "syncing_source",
        generation: 0,
        createdAt: NOW,
        updatedAt: NOW,
      };
      expect((await git.create(plan, authority)).status).toBe("created");
      const claim = await git.claimReconcile({
        id: plan.id,
        expectedGeneration: 0,
        leaseToken: "git-management-lease",
        claimedAt: NOW,
        leaseExpiresAt: "2026-08-10T00:00:30.000Z",
        expectedWorkspaceManagementAuthority: authority,
      });
      expect(claim.status).toBe("claimed");
      if (claim.status !== "claimed") throw new Error("Git lease was not acquired");

      const interfaces = createD1InterfaceStores(database);
      const service = new InterfaceService({ stores: interfaces, now: () => NOW });
      const initial = await service.create({
        workspaceId: WORKSPACE_ID,
        name: "management-observation",
        ownerRef: { kind: "Capsule", id: CAPSULE_ID },
        spec: {
          type: "example.http",
          version: "v1",
          document: { endpoint: "https://example.test" },
          access: { visibility: "workspace" },
        },
      });
      const pending = {
        ...initial,
        status: {
          ...initial.status,
          conditions: [{
            type: "ObservationPending",
            status: "true" as const,
            reason: "PlanObservationPending",
            message: "plan-before-drain",
            observedGeneration: initial.metadata.generation,
            lastTransitionAt: NOW,
          }],
        },
      };
      expect(await interfaces.interfaces.compareAndSet(pending, {
        generation: initial.metadata.generation,
        resolvedRevision: initial.status.resolvedRevision,
        record: initial,
        requireActiveWorkspace: true,
      })).toBe(true);

      const successorInstallConfig: InstallConfig = {
        id: "config_management_successor",
        workspaceId: WORKSPACE_ID,
        name: "management successor",
        variableMapping: {},
        outputAllowlist: {},
        policy: {},
        internal: {
          reason: "per_install_overrides",
          reAdoption: {
            capsuleId: CAPSULE_ID,
            actorSubject: "management-owner",
            reason: "Change configuration",
            idempotencyKeyHash: `sha256:${"1".repeat(64)}`,
            requestDigest: `sha256:${"2".repeat(64)}`,
            previousInstallConfigId: "config_previous",
            previousInstallConfigDigest: `sha256:${"3".repeat(64)}`,
            previousCapsuleStatus: "active",
            previousStateGeneration: 0,
            previousExecutionAuthorityEpoch: 1,
            authorityGuard: `sha256:${"4".repeat(64)}`,
            derivedTargetDigest: `sha256:${"5".repeat(64)}`,
            baseInstallConfigId: "config_base",
            sourceSnapshotId: "snapshot_prepared",
          },
        },
        createdAt: NOW,
        updatedAt: NOW,
      };
      await expect(
        management.createInstallConfigIfAbsent(
          successorInstallConfig,
          { ...authority, managementEpoch: 2 },
        ),
      ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect(
        await management.getInstallConfig(successorInstallConfig.id),
      ).toBeUndefined();
      expect(
        await management.createInstallConfigIfAbsent(
          successorInstallConfig,
          authority,
        ),
      ).toBe(true);
      expect(
        await management.getInstallConfig(successorInstallConfig.id),
      ).toEqual(successorInstallConfig);

      expect(await management.getInstallConfigManagementAuthority(successorInstallConfig.id)).toEqual(authority);
      const forgedConfig = {
        ...successorInstallConfig,
        workspaceManagementAuthority: { ...authority, managementEpoch: 99 },
      };
      expect(await management.putInstallConfig(forgedConfig)).toEqual(successorInstallConfig);
      await management.putInstallConfig(successorInstallConfig);
      const reopened = new CloudflareD1OpenTofuControlStore(database);
      expect(await reopened.getInstallConfigManagementAuthority(successorInstallConfig.id)).toEqual(authority);
      expect(await reopened.getInstallConfigsByIds([successorInstallConfig.id])).toEqual([successorInstallConfig]);
      expect((await reopened.listInstallConfigsPage(WORKSPACE_ID, { limit: 10 })).items).toEqual([successorInstallConfig]);
      const legacy = { ...successorInstallConfig, id: "config_legacy_without_authority" };
      await reopened.putInstallConfig({ ...forgedConfig, id: legacy.id });
      expect(await reopened.getInstallConfig(legacy.id)).toEqual(legacy);
      expect(await reopened.getInstallConfigManagementAuthority(legacy.id)).toBeUndefined();

      expect((await management.beginWorkspaceDraining(WORKSPACE_ID, authority)).status).toBe("started");
      expect(
        await management.createInstallConfigIfAbsent(successorInstallConfig),
      ).toBe(false);
      expect(
        await management.getInstallConfig(successorInstallConfig.id),
      ).toEqual(successorInstallConfig);
      const deniedInstallConfig: InstallConfig = {
        ...successorInstallConfig,
        id: "config_management_denied",
        name: "management denied",
      };
      await expect(
        management.createInstallConfigIfAbsent(deniedInstallConfig),
      ).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect(
        await management.getInstallConfig(deniedInstallConfig.id),
      ).toBeUndefined();
      const neutralInstallConfig: InstallConfig = {
        id: "config_management_neutral",
        name: "management neutral",
        variableMapping: {},
        outputAllowlist: {},
        policy: {},
        createdAt: NOW,
        updatedAt: NOW,
      };
      expect(
        await management.createInstallConfigIfAbsent(neutralInstallConfig),
      ).toBe(true);
      expect(
        await management.getInstallConfig(neutralInstallConfig.id),
      ).toEqual(neutralInstallConfig);

      expect(await git.create(plan, authority)).toMatchObject({
        status: "replayed",
        plan: claim.claim.plan,
      });
      await expect(git.create({ ...plan, id: "git-after-drain", idempotencyKeyHash: "new-key-hash" }))
        .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect(await git.get("git-after-drain")).toBeUndefined();
      await expect(git.claimReconcile({
        id: plan.id,
        expectedGeneration: 1,
        leaseToken: "replacement-lease",
        claimedAt: "2026-08-10T00:01:00.000Z",
        leaseExpiresAt: "2026-08-10T00:01:30.000Z",
      })).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect(await git.get(plan.id)).toEqual(claim.claim.plan);

      const observed = {
        ...pending,
        status: { ...pending.status, conditions: [] },
      };
      const guard = {
        generation: pending.metadata.generation,
        resolvedRevision: pending.status.resolvedRevision,
        record: pending,
      };
      await expect(interfaces.interfaces.compareAndSet(observed, {
        ...guard,
        requireActiveWorkspace: true,
      })).rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
      expect(await interfaces.interfaces.get(pending.metadata.id)).toEqual(pending);

      // Existing lease completion and terminal observation retain their own
      // exact-record authority; stopping admission must not strand settlement.
      expect((await git.completeReconcile({
        id: plan.id,
        expectedGeneration: 1,
        leaseToken: "git-management-lease",
        plan: { ...claim.claim.plan, phase: "compiling_install", sourceId: "source-committed" },
      })).status).toBe("completed");
      expect(await interfaces.interfaces.compareAndSet(observed, guard)).toBe(true);
    } finally {
      await runtime.dispose();
    }
  }, 30_000);

  test("durable resolvers use one indexed database snapshot", async () => {
    const d1Records: RecordedQuery[] = [];
    const database = new SqliteFakeD1();
    const d1Store = new CloudflareD1OpenTofuControlStore(
      recordingD1(database, d1Records),
    );
    await d1Store.putCapsule(capsule());
    d1Records.length = 0;
    await expect(
      d1Store.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID),
    ).resolves.toMatchObject({ executionAuthorityEpoch: 1 });
    const d1AuthorityQueries = d1Records.filter((entry) =>
      entry.sql.includes("latest_capsule_runtime_safety"),
    );
    expect(d1AuthorityQueries).toHaveLength(1);
    const [d1AuthorityQuery] = d1AuthorityQueries;
    if (!d1AuthorityQuery) throw new Error("D1 authority query is missing");
    const d1Plan = await database
      .prepare(`explain query plan ${d1AuthorityQuery.sql}`)
      .bind(...d1AuthorityQuery.parameters)
      .all<{ readonly detail: string }>();
    const d1PlanDetails = (d1Plan.results ?? []).map((row) => row.detail);
    expect(d1PlanDetails).toContain(
      "SEARCH capsules USING INDEX capsules_execution_authority_exact_idx (space_id=? AND id=?)",
    );
    expect(
      d1PlanDetails.some((detail) =>
        detail.includes("runs_installation_idx (installation_id=?)"),
      ),
    ).toBe(true);

    const client = await PGliteSqlClient.create();
    clients.push(client);
    const pgRecords: RecordedQuery[] = [];
    const pgStore = new SqlOpenTofuControlStore({
      client: recordingSqlClient(client, pgRecords),
    });
    await pgStore.putCapsule(capsule());
    await client.exec(`insert into takosumi_runs (
      id, kind, space_id, installation_id, status, created_at, run_json
    )
    select
      'authority_filler_run_' || n,
      'apply',
      '${WORKSPACE_ID}',
      'authority_filler_capsule_' || n,
      'succeeded',
      '1',
      '{}'::jsonb
    from generate_series(1, 500) as n`);
    await client.exec("analyze takosumi_runs");
    pgRecords.length = 0;
    await expect(
      pgStore.resolveCapsuleExecutionAuthority(WORKSPACE_ID, CAPSULE_ID),
    ).resolves.toMatchObject({ executionAuthorityEpoch: 1 });
    const pgAuthorityQueries = pgRecords.filter((entry) =>
      entry.sql.includes("latest_capsule_runtime_safety"),
    );
    expect(pgAuthorityQueries).toHaveLength(1);
    const [pgAuthorityQuery] = pgAuthorityQueries;
    if (!pgAuthorityQuery) {
      throw new Error("Postgres authority query is missing");
    }
    const pgPlan = await client.query<{ readonly "QUERY PLAN": unknown }>(
      `explain (format json) ${pgAuthorityQuery.sql}`,
      pgAuthorityQuery.parameters,
    );
    const pgPlanJson = JSON.stringify(pgPlan.rows);
    expect(pgPlanJson).toContain(
      "takosumi_capsules_execution_authority_exact_idx",
    );
    expect(pgPlanJson).toContain("takosumi_runs_installation_created_at_idx");
  });

  test("resolver suspends unsafe runtime phases without consuming an epoch", async () => {
    let phase: "safe" | "terminating" | "unknown" = "safe";
    let reads = 0;
    const resolver = createCapsuleExecutionAuthorityResolver({
      async resolveCapsuleExecutionAuthority(workspaceId, capsuleId) {
        reads += 1;
        return phase === "safe"
          ? { workspaceId, capsuleId, executionAuthorityEpoch: 7 }
          : undefined;
      },
      async resolveCapsuleExecutionAuthorities(inputs) {
        return inputs.map(({ workspaceId, capsuleId }) =>
          phase === "safe"
            ? { workspaceId, capsuleId, executionAuthorityEpoch: 7 }
            : undefined,
        );
      },
    });

    await expect(
      resolver.resolveExact({
        workspaceId: WORKSPACE_ID,
        capsuleId: CAPSULE_ID,
      }),
    ).resolves.toMatchObject({ executionAuthorityEpoch: 7 });
    expect(reads).toBe(1);

    phase = "terminating";
    await expect(
      resolver.resolveExact({
        workspaceId: WORKSPACE_ID,
        capsuleId: CAPSULE_ID,
      }),
    ).resolves.toBeUndefined();
    phase = "unknown";
    await expect(
      resolver.resolveExact({
        workspaceId: WORKSPACE_ID,
        capsuleId: CAPSULE_ID,
      }),
    ).resolves.toBeUndefined();
  });

  test("resolver cannot authorize across a terminating-Run interleaving", async () => {
    let phase: "safe" | "terminating" = "safe";
    let atomicReads = 0;
    let legacyReads = 0;
    const interleavableStore = {
      async resolveCapsuleExecutionAuthority(
        workspaceId: string,
        capsuleId: string,
      ) {
        atomicReads += 1;
        phase = "terminating";
        return undefined;
      },
      async resolveCapsuleExecutionAuthorities() {
        phase = "terminating";
        return [];
      },
      async getCapsuleExecutionAuthority(
        workspaceId: string,
        capsuleId: string,
      ) {
        legacyReads += 1;
        if (legacyReads === 2) phase = "terminating";
        return {
          workspaceId,
          capsuleId,
          executionAuthorityEpoch: 7,
        };
      },
      async getCapsuleRuntimeSafety() {
        return phase === "safe"
          ? { phase, runId: "run_apply", runType: "apply" }
          : { phase, runId: "run_destroy", runType: "destroy_apply" };
      },
    };
    const resolver =
      createCapsuleExecutionAuthorityResolver(interleavableStore);

    await expect(
      resolver.resolveExact({
        workspaceId: WORKSPACE_ID,
        capsuleId: CAPSULE_ID,
      }),
    ).resolves.toBeUndefined();
    expect(atomicReads).toBe(1);
    expect(legacyReads).toBe(0);
  });

  test("batch resolver delegates once without per-item interleaving", async () => {
    let singleReads = 0;
    let batchReads = 0;
    const resolver = createCapsuleExecutionAuthorityResolver({
      async resolveCapsuleExecutionAuthority(workspaceId, capsuleId) {
        singleReads += 1;
        return { workspaceId, capsuleId, executionAuthorityEpoch: singleReads };
      },
      async resolveCapsuleExecutionAuthorities(inputs) {
        batchReads += 1;
        return inputs.map(({ workspaceId, capsuleId }) => ({
          workspaceId,
          capsuleId,
          executionAuthorityEpoch: 11,
        }));
      },
    });

    await expect(
      resolver.resolveExactMany([
        { workspaceId: WORKSPACE_ID, capsuleId: BATCH_CAPSULE_A },
        { workspaceId: WORKSPACE_ID, capsuleId: BATCH_CAPSULE_B },
      ]),
    ).resolves.toEqual([
      {
        workspaceId: WORKSPACE_ID,
        capsuleId: BATCH_CAPSULE_A,
        executionAuthorityEpoch: 11,
      },
      {
        workspaceId: WORKSPACE_ID,
        capsuleId: BATCH_CAPSULE_B,
        executionAuthorityEpoch: 11,
      },
    ]);
    expect(batchReads).toBe(1);
    expect(singleReads).toBe(0);
  });

  test("D1 v64 upgrades a populated v63 row and fences an older writer", async () => {
    const database = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(database, {
      throughMigrationVersion: 63,
    });
    await database
      .prepare(
        `insert into capsules (
           id, space_id, project_id, name, slug, source_id,
           install_config_id, environment, current_state_generation,
           status, record_json, created_at, updated_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)`,
      )
      .bind(
        CAPSULE_ID,
        WORKSPACE_ID,
        "project_authority",
        "authority",
        "authority",
        "source_authority",
        "config_authority",
        "production",
        JSON.stringify(capsule()),
        NOW,
        NOW,
      )
      .run();

    await ensureD1OpenTofuLedgerSchema(database);
    expect(
      await database
        .prepare(
          `select execution_authority_epoch as epoch
             from capsules where id = ?`,
        )
        .bind(CAPSULE_ID)
        .first(),
    ).toEqual({ epoch: 1 });
    const d1Plan = await database
      .prepare(
        `explain query plan
         select execution_authority_epoch from capsules
          where id = ? and space_id = ? and status <> 'destroyed'
          limit 1`,
      )
      .bind(CAPSULE_ID, WORKSPACE_ID)
      .all<{ readonly detail: string }>();
    expect((d1Plan.results ?? []).map((row) => row.detail)).toEqual([
      "SEARCH capsules USING INDEX sqlite_autoindex_capsules_1 (id=?)",
    ]);
    await database
      .prepare(`update capsules set status = 'destroyed' where id = ?`)
      .bind(CAPSULE_ID)
      .run();
    expect(
      await database
        .prepare(
          `select execution_authority_epoch as epoch
             from capsules where id = ?`,
        )
        .bind(CAPSULE_ID)
        .first(),
    ).toEqual({ epoch: 2 });
  });

  test("Postgres v108 upgrades a populated v107 row and fences an older writer", async () => {
    const client = await PGliteSqlClient.createThroughMigrationVersion(107);
    clients.push(client);
    await client.exec(`insert into takosumi_capsules (
      id, space_id, project_id, name, environment, source_id,
      install_config_id, current_state_version_id, status,
      installation_json, created_at, updated_at
    ) values (
      '${CAPSULE_ID}', '${WORKSPACE_ID}', 'project_authority', 'authority',
      'production', 'source_authority', 'config_authority', null, 'active',
      '${JSON.stringify(capsule())}'::jsonb, '${NOW}', '${NOW}'
    )`);
    const migration = postgresStorageMigrationStatements.find(
      (entry) => entry.version === 108,
    );
    if (!migration) throw new Error("Postgres v108 migration is missing");
    for (const statement of splitSqlStatements(migration.sql)) {
      await client.exec(statement);
    }

    expect(
      (
        await client.query<{ execution_authority_epoch: number }>(
          `select execution_authority_epoch
             from takosumi_capsules where id = $1`,
          [CAPSULE_ID],
        )
      ).rows,
    ).toEqual([{ execution_authority_epoch: 1 }]);
    await client.exec(`insert into takosumi_capsules (
      id, space_id, project_id, name, environment, source_id,
      install_config_id, current_state_version_id, status,
      installation_json, created_at, updated_at
    )
    select
      'capsule_authority_filler_' || n,
      '${WORKSPACE_ID}',
      'project_authority',
      'authority-filler-' || n,
      'production',
      'source_authority',
      'config_authority',
      null,
      'active',
      jsonb_build_object('id', 'capsule_authority_filler_' || n),
      '${NOW}',
      '${NOW}'
    from generate_series(1, 500) as n`);
    await client.exec("analyze takosumi_capsules");
    const postgresPlan = await client.query<{ readonly "QUERY PLAN": unknown }>(
      `explain (format json)
       select execution_authority_epoch from takosumi_capsules
        where id = $1 and space_id = $2 and status <> 'destroyed'
        limit 1`,
      [CAPSULE_ID, WORKSPACE_ID],
    );
    expect(JSON.stringify(postgresPlan.rows)).toContain(
      "takosumi_capsules_execution_authority_exact_idx",
    );
    await client.query(
      `update takosumi_capsules set status = 'destroyed' where id = $1`,
      [CAPSULE_ID],
    );
    expect(
      (
        await client.query<{ execution_authority_epoch: number }>(
          `select execution_authority_epoch
             from takosumi_capsules where id = $1`,
          [CAPSULE_ID],
        )
      ).rows,
    ).toEqual([{ execution_authority_epoch: 2 }]);
  });
});
