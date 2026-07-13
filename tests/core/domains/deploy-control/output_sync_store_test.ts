import { afterAll, expect, test } from "bun:test";
import {
  PGlite,
  type Transaction as PGliteTransaction,
} from "@electric-sql/pglite";

import type {
  Installation,
  StateSnapshot,
} from "@takosumi/internal/deploy-control-api";
import type { WorkspaceOutputSyncState } from "takosumi-contract";
import type { Output as OutputSnapshot } from "takosumi-contract/outputs";
import type { Workspace as Space } from "takosumi-contract/workspaces";
import type { OpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
  SqlTransaction,
} from "../../../../core/adapters/storage/sql.ts";
import { SqlOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import {
  CloudflareD1OpenTofuDeploymentStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const TS = "2026-07-13T00:00:00.000Z";
const TS_NEXT = "2026-07-13T00:00:01.000Z";
const pgClients: OutputSyncPGliteClient[] = [];

afterAll(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

async function persistentStores(): Promise<
  readonly [string, OpenTofuDeploymentStore][]
> {
  const pgClient = await OutputSyncPGliteClient.create();
  pgClients.push(pgClient);
  return [
    ["pg", new SqlOpenTofuDeploymentStore({ client: pgClient })],
    ["d1", new CloudflareD1OpenTofuDeploymentStore(new SqliteFakeD1())],
  ];
}

type QueryRunner = Pick<PGlite, "query"> | PGliteTransaction;

class OutputSyncPGliteClient implements SqlClient {
  private constructor(private readonly db: PGlite) {}

  static async create(): Promise<OutputSyncPGliteClient> {
    const db = new PGlite();
    await db.exec(`
      create table takosumi_workspace_output_sync (
        workspace_id text primary key,
        enabled boolean not null default true,
        output_revision integer not null default 0,
        reconciled_revision integer not null default 0,
        active_run_group_id text,
        consecutive_passes integer not null default 0,
        updated_at text not null
      );
      create table takosumi_capsules (
        id text primary key,
        space_id text not null,
        project_id text,
        name text not null,
        environment text not null,
        source_id text,
        install_config_id text not null,
        current_state_version_id text,
        status text not null,
        installation_json jsonb not null,
        created_at text not null,
        updated_at text not null
      );
      create table takosumi_state_versions (
        id text primary key,
        space_id text not null,
        installation_id text not null,
        environment text not null,
        generation integer not null,
        snapshot_json jsonb not null,
        created_at text not null,
        unique (installation_id, environment, generation)
      );
      create table takosumi_outputs (
        id text primary key,
        space_id text not null,
        installation_id text not null,
        state_generation integer not null,
        snapshot_json jsonb not null,
        created_at text not null
      );
    `);
    return new OutputSyncPGliteClient(db);
  }

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    return runPgQuery<Row>(this.db, sql, parameters);
  }

  async transaction<T>(
    fn: (transaction: SqlTransaction) => T | Promise<T>,
  ): Promise<T> {
    return (await this.db.transaction(async (tx) => {
      const handle: SqlTransaction = {
        query: (sql, parameters) => runPgQuery(tx, sql, parameters),
        transaction: (nested) => Promise.resolve(nested(handle)),
      };
      return await fn(handle);
    })) as T;
  }

  close(): Promise<void> {
    return this.db.close();
  }
}

async function runPgQuery<Row extends Record<string, unknown>>(
  runner: QueryRunner,
  sql: string,
  parameters?: SqlParameters,
): Promise<SqlQueryResult<Row>> {
  if (parameters !== undefined && !Array.isArray(parameters)) {
    throw new TypeError("Output Sync PGlite client expects positional params");
  }
  const params =
    parameters === undefined ? undefined : ([...parameters] as unknown[]);
  const result = await runner.query<Row>(sql, params);
  return {
    rows: result.rows,
    rowCount: result.affectedRows ?? result.rows.length,
  };
}

function space(id: string): Space {
  return {
    id,
    handle: id,
    displayName: id,
    type: "personal",
    ownerUserId: `owner_${id}`,
    createdAt: TS,
    updatedAt: TS,
  };
}

function capsule(
  id: string,
  workspaceId: string,
  overrides: Partial<Installation> = {},
): Installation {
  return {
    id,
    workspaceId,
    spaceId: workspaceId,
    name: id,
    slug: id,
    sourceId: `source_${id}`,
    installType: "opentofu_module",
    installConfigId: `config_${id}`,
    environment: "production",
    currentStateGeneration: 0,
    status: "active",
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function output(
  id: string,
  workspaceId: string,
  capsuleId: string,
  stateGeneration: number,
): OutputSnapshot {
  return {
    id,
    workspaceId,
    spaceId: workspaceId,
    capsuleId,
    installationId: capsuleId,
    stateGeneration,
    rawOutputArtifactKey: `${workspaceId}/${capsuleId}/${id}.json.enc`,
    publicOutputs: { url: `https://${id}.example.com` },
    workspaceOutputs: { url: `https://${id}.example.com` },
    spaceOutputs: { url: `https://${id}.example.com` },
    outputDigest: `sha256:${id}`,
    createdAt: TS,
  };
}

function stateVersion(
  id: string,
  workspaceId: string,
  capsuleId: string,
  generation: number,
): StateSnapshot {
  return {
    id,
    workspaceId,
    spaceId: workspaceId,
    capsuleId,
    installationId: capsuleId,
    environment: "production",
    generation,
    objectKey: `${workspaceId}/${capsuleId}/${id}.tfstate.enc`,
    digest: `sha256:${id}`,
    createdByRunId: `run_${id}`,
    createdAt: TS,
  };
}

test("Output Sync state persists and recoverable listing includes active groups", async () => {
  const states: readonly WorkspaceOutputSyncState[] = [
    {
      workspaceId: "workspace_a",
      enabled: true,
      outputRevision: 2,
      reconciledRevision: 1,
      consecutivePasses: 0,
      updatedAt: TS,
    },
    {
      workspaceId: "workspace_b",
      enabled: true,
      outputRevision: 3,
      reconciledRevision: 1,
      activeRunGroupId: "group_1",
      consecutivePasses: 1,
      updatedAt: TS_NEXT,
    },
    {
      workspaceId: "workspace_c",
      enabled: false,
      outputRevision: 4,
      reconciledRevision: 0,
      consecutivePasses: 0,
      updatedAt: TS_NEXT,
    },
    {
      workspaceId: "workspace_d",
      enabled: true,
      outputRevision: 1,
      reconciledRevision: 1,
      consecutivePasses: 0,
      updatedAt: TS_NEXT,
    },
  ];

  for (const [label, store] of await persistentStores()) {
    for (const state of states) await store.putWorkspaceOutputSyncState(state);

    expect(
      await store.getWorkspaceOutputSyncState("workspace_b"),
      label,
    ).toEqual(states[1]);
    expect(
      await store.getWorkspaceOutputSyncState("missing"),
      label,
    ).toBeUndefined();
    expect(
      (await store.listPendingWorkspaceOutputSyncStates(10)).map(
        (state) => state.workspaceId,
      ),
      label,
    ).toEqual(["workspace_a", "workspace_b"]);
    expect(await store.listPendingWorkspaceOutputSyncStates(0), label).toEqual(
      [],
    );
  }
});

test("commitAppliedDeployment atomically bumps Output Sync while disabled", async () => {
  for (const [label, store] of await persistentStores()) {
    await store.putOutputSnapshot(
      output("output_old", "workspace_1", "capsule_1", 1),
    );
    await store.putInstallation(
      capsule("capsule_1", "workspace_1", {
        currentStateGeneration: 1,
        currentOutputSnapshotId: "output_old",
      }),
    );
    await store.putWorkspaceOutputSyncState({
      workspaceId: "workspace_1",
      enabled: false,
      outputRevision: 4,
      reconciledRevision: 2,
      consecutivePasses: 0,
      updatedAt: TS,
    });

    const committed = await store.commitAppliedDeployment({
      stateSnapshot: stateVersion("state_2", "workspace_1", "capsule_1", 2),
      outputSnapshot: output("output_new", "workspace_1", "capsule_1", 2),
      outputSyncRevisionBump: {
        workspaceId: "workspace_1",
        updatedAt: TS_NEXT,
      },
      installationPatch: {
        id: "capsule_1",
        patch: {
          currentStateGeneration: 2,
          currentOutputSnapshotId: "output_new",
          updatedAt: TS_NEXT,
        },
        guard: { currentDeploymentId: undefined, status: "active" },
      },
    });

    expect(committed.outputSyncState, label).toMatchObject({
      workspaceId: "workspace_1",
      enabled: false,
      outputRevision: 5,
      reconciledRevision: 2,
      updatedAt: TS_NEXT,
    });
    expect(
      await store.getWorkspaceOutputSyncState("workspace_1"),
      label,
    ).toEqual(committed.outputSyncState);
    expect(await store.listPendingWorkspaceOutputSyncStates(10), label).toEqual(
      [],
    );
    await store.putOutputSnapshot(
      output("output_canonical", "workspace_1", "capsule_2", 1),
    );
    await store.putInstallation(
      capsule("capsule_2", "workspace_1", {
        currentOutputId: "output_canonical",
      }),
    );
    expect(
      (await store.listCurrentOutputsByWorkspace("workspace_1")).map(
        ({ capsule, output }) => [capsule.id, output.id],
      ),
      label,
    ).toEqual([
      ["capsule_1", "output_new"],
      ["capsule_2", "output_canonical"],
    ]);

    await expect(
      store.commitAppliedDeployment({
        stateSnapshot: stateVersion(
          "state_torn",
          "workspace_1",
          "capsule_1",
          3,
        ),
        outputSnapshot: output("output_torn", "workspace_1", "capsule_1", 3),
        outputSyncRevisionBump: {
          workspaceId: "workspace_1",
          updatedAt: "2026-07-13T00:00:02.000Z",
        },
        installationPatch: {
          id: "capsule_1",
          patch: {
            currentStateGeneration: 3,
            currentOutputSnapshotId: "output_torn",
            updatedAt: "2026-07-13T00:00:02.000Z",
          },
          guard: { currentDeploymentId: "stale" },
        },
      }),
      label,
    ).rejects.toThrow();
    expect(
      (await store.getWorkspaceOutputSyncState("workspace_1"))?.outputRevision,
      label,
    ).toBe(5);
    expect(await store.getOutputSnapshot("output_torn"), label).toBeUndefined();
  }
});

test("D1 migration 26 backfills existing Workspace revisions", async () => {
  const db = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuDeploymentStore(db);
  await store.putSpace(space("workspace_with_output"));
  await store.putSpace(space("workspace_without_output"));
  await store.putOutputSnapshot(
    output("output_existing", "workspace_with_output", "capsule_existing", 1),
  );
  await store.putInstallation(
    capsule("capsule_existing", "workspace_with_output", {
      currentOutputId: "output_existing",
    }),
  );
  await db.prepare("delete from workspace_output_sync").run();
  await db.prepare("delete from schema_migrations where version = 26").run();

  await ensureD1OpenTofuLedgerSchema(db);

  const rows = await db
    .prepare(
      `select workspace_id, enabled, output_revision, reconciled_revision
       from workspace_output_sync
       order by workspace_id`,
    )
    .all<{
      workspace_id: string;
      enabled: number;
      output_revision: number;
      reconciled_revision: number;
    }>();
  expect(rows.results).toEqual([
    {
      workspace_id: "workspace_with_output",
      enabled: 1,
      output_revision: 1,
      reconciled_revision: 0,
    },
    {
      workspace_id: "workspace_without_output",
      enabled: 1,
      output_revision: 0,
      reconciled_revision: 0,
    },
  ]);
});
