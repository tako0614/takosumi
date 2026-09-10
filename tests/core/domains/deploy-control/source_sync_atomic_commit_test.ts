import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import type {
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type { Workspace } from "takosumi-contract/workspaces";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
  SqlTransaction,
} from "../../../../core/adapters/storage/sql.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(30_000);

const CREATED_AT = "2026-08-27T00:00:00.000Z";
const STARTED_AT = "2026-08-27T00:00:01.000Z";
const FINISHED_AT = "2026-08-27T00:00:02.000Z";
const RUN_ID = "ssr_atomic_1";
const SNAPSHOT_ID = "snap_atomic_1";
const SOURCE_ID = "src_atomic_1";
const WORKSPACE_ID = "workspace_atomic_1";
const ARCHIVE_REF =
  "workspaces/workspace_atomic_1/sources/src_atomic_1/snapshots/snap_atomic_1/source.tar.zst";

const pgClients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

function queuedRun(): SourceSyncRun {
  return {
    id: RUN_ID,
    kind: "source_sync",
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    url: "https://example.com/acme/app.git",
    ref: "main",
    path: ".",
    archiveRef: ARCHIVE_REF,
    intent: "observe",
    status: "queued",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    snapshotId: SNAPSHOT_ID,
  };
}

function succeededRun(
  running: SourceSyncRun,
  resolvedCommit: string,
): SourceSyncRun {
  return {
    ...running,
    status: "succeeded",
    heartbeatAt: 2_000,
    finishedAt: FINISHED_AT,
    updatedAt: FINISHED_AT,
    resolvedCommit,
    archiveDigest: `sha256:${resolvedCommit}`,
    archiveSizeBytes: 4_096,
    snapshotId: SNAPSHOT_ID,
  };
}

function sourceSnapshot(resolvedCommit: string): SourceSnapshot {
  return {
    id: SNAPSHOT_ID,
    origin: "git",
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    url: "https://example.com/acme/app.git",
    ref: "main",
    resolvedCommit,
    path: ".",
    archiveRef: ARCHIVE_REF,
    archiveDigest: `sha256:${resolvedCommit}`,
    archiveSizeBytes: 4_096,
    repositoryInstallMetadata: { status: "absent" },
    repositoryManifest: { status: "absent" },
    repositoryModules: { status: "ready", scopePath: ".", modules: [] },
    fetchedByRunId: RUN_ID,
    fetchedAt: FINISHED_AT,
  };
}

function workspace(): Workspace {
  return {
    id: WORKSPACE_ID,
    handle: "workspace-atomic-1",
    displayName: "Workspace Atomic 1",
    type: "personal",
    ownerUserId: "owner_atomic_1",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

async function claimRun(
  store: OpenTofuControlStore,
  leaseToken: string,
): Promise<SourceSyncRun> {
  const queued = queuedRun();
  await store.putWorkspace(workspace());
  await store.beginSourceSyncRun(queued, {
    workspaceId: WORKSPACE_ID,
    managementState: "active",
    managementEpoch: 1,
  });
  const running: SourceSyncRun = {
    ...queued,
    status: "running",
    startedAt: STARTED_AT,
    heartbeatAt: 1_000,
    updatedAt: STARTED_AT,
  };
  const claimed = await store.transitionRun({
    id: queued.id,
    kind: "source_sync",
    expectFrom: ["queued"],
    run: running,
    setLeaseToken: leaseToken,
    heartbeatAt: running.heartbeatAt,
  });
  expect(claimed.won).toBe(true);
  return claimed.run as SourceSyncRun;
}

async function stores(): Promise<
  readonly (readonly [string, OpenTofuControlStore])[]
> {
  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client: pgClient })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

test("source-sync success atomically publishes its canonical snapshot on every store", async () => {
  for (const [label, store] of await stores()) {
    const running = await claimRun(store, `lease_${label}`);
    const terminal = succeededRun(running, `commit-${label}`);
    const snapshot = sourceSnapshot(`commit-${label}`);

    const committed = await store.commitSourceSyncSuccess({
      terminalRun: terminal,
      leaseToken: `lease_${label}`,
      snapshot,
    });

    expect(committed.won, label).toBe(true);
    expect(await store.getSourceSyncRun(RUN_ID), label).toEqual(terminal);
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), label).toEqual(snapshot);

    const replay = await store.commitSourceSyncSuccess({
      terminalRun: terminal,
      leaseToken: `lease_${label}`,
      snapshot,
    });
    expect(replay.won, `${label}: replay`).toBe(false);
    expect(replay.run?.status, `${label}: replay`).toBe("succeeded");
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), `${label}: replay`).toEqual(
      snapshot,
    );
  }
});

test("same-lease Source success advances only its default cursor atomically while draining", async () => {
  for (const [label, store] of await stores()) {
    const running = await claimRun(store, `lease_cursor_${label}`);
    const source = {
      id: SOURCE_ID,
      workspaceId: WORKSPACE_ID,
      name: "configuration-kept",
      url: running.url,
      defaultRef: running.ref,
      defaultPath: running.path,
      hookSecretHash: "hook-hash-kept",
      autoSync: false,
      status: "active" as const,
      lastSeenCommit: "previous-commit",
      createdAt: CREATED_AT,
      updatedAt: STARTED_AT,
    };
    await store.putSource(source);
    await store.beginWorkspaceDraining(WORKSPACE_ID, {
      workspaceId: WORKSPACE_ID, managementState: "active", managementEpoch: 1,
    });
    expect((await store.commitSourceSyncSuccess({
      terminalRun: succeededRun(running, "next-commit"),
      leaseToken: `lease_cursor_${label}`,
      snapshot: sourceSnapshot("next-commit"),
    })).won).toBe(true);
    expect(await store.getSource(SOURCE_ID), label).toEqual({
      ...source,
      lastSeenCommit: "next-commit",
      updatedAt: FINISHED_AT,
    });
  }
});

test("source-sync success exactly adopts an identical immutable snapshot", async () => {
  for (const [label, store] of await stores()) {
    const snapshot = sourceSnapshot(`adopt-${label}`);
    await store.putSourceSnapshot(snapshot);
    const running = await claimRun(store, `lease_adopt_${label}`);
    const terminal = succeededRun(running, `adopt-${label}`);

    const committed = await store.commitSourceSyncSuccess({
      terminalRun: terminal,
      leaseToken: `lease_adopt_${label}`,
      snapshot,
    });

    expect(committed.won, label).toBe(true);
    expect(await store.getSourceSyncRun(RUN_ID), label).toEqual(terminal);
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), label).toEqual(snapshot);
  }
});

test("a snapshot id collision rolls back the terminal run and preserves immutable content", async () => {
  for (const [label, store] of await stores()) {
    const existing = sourceSnapshot(`existing-${label}`);
    await store.putSourceSnapshot(existing);
    const running = await claimRun(store, `lease_collision_${label}`);
    const terminal = succeededRun(running, `candidate-${label}`);
    const candidate = sourceSnapshot(`candidate-${label}`);
    const source = {
      id: SOURCE_ID,
      workspaceId: WORKSPACE_ID,
      name: "collision-cursor",
      url: running.url,
      defaultRef: running.ref,
      defaultPath: running.path,
      hookSecretHash: "kept-hash",
      autoSync: false,
      status: "active" as const,
      lastSeenCommit: "kept-commit",
      createdAt: CREATED_AT,
      updatedAt: STARTED_AT,
    };
    await store.putSource(source);

    await expect(
      Promise.resolve().then(() =>
        store.commitSourceSyncSuccess({
          terminalRun: terminal,
          leaseToken: `lease_collision_${label}`,
          snapshot: candidate,
        }),
      ),
    ).rejects.toThrow("different canonical content");

    expect((await store.getSourceSyncRun(RUN_ID))?.status, label).toBe("running");
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), label).toEqual(existing);
    expect(await store.getSource(SOURCE_ID), label).toEqual(source);
  }
});

test("a stale source-sync lease cannot publish or overwrite the winner snapshot", async () => {
  for (const [label, store] of await stores()) {
    const firstRunning = await claimRun(store, `lease_first_${label}`);
    const winnerRunning: SourceSyncRun = {
      ...firstRunning,
      heartbeatAt: 1_500,
      updatedAt: "2026-08-27T00:00:01.500Z",
    };
    const takeover = await store.transitionRun({
      id: RUN_ID,
      kind: "source_sync",
      expectFrom: ["running"],
      expectHeartbeatAt: firstRunning.heartbeatAt ?? null,
      run: winnerRunning,
      setLeaseToken: `lease_winner_${label}`,
      heartbeatAt: winnerRunning.heartbeatAt,
    });
    expect(takeover.won, label).toBe(true);

    const staleCommit = await store.commitSourceSyncSuccess({
      terminalRun: succeededRun(firstRunning, `stale-${label}`),
      leaseToken: `lease_first_${label}`,
      snapshot: sourceSnapshot(`stale-${label}`),
    });
    expect(staleCommit.won, `${label}: stale`).toBe(false);
    expect(staleCommit.run?.status, `${label}: stale`).toBe("running");
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), `${label}: stale`).toBeUndefined();

    const winnerTerminal = succeededRun(
      takeover.run as SourceSyncRun,
      `winner-${label}`,
    );
    const winnerSnapshot = sourceSnapshot(`winner-${label}`);
    const winnerCommit = await store.commitSourceSyncSuccess({
      terminalRun: winnerTerminal,
      leaseToken: `lease_winner_${label}`,
      snapshot: winnerSnapshot,
    });
    expect(winnerCommit.won, `${label}: winner`).toBe(true);
    expect(await store.getSourceSyncRun(RUN_ID), `${label}: winner`).toEqual(
      winnerTerminal,
    );
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), `${label}: winner`).toEqual(
      winnerSnapshot,
    );
  }
});

test("stores reject a succeeded source-sync run paired with a non-canonical snapshot", async () => {
  for (const [label, store] of await stores()) {
    const running = await claimRun(store, `lease_mismatch_${label}`);
    const terminal = succeededRun(running, `mismatch-${label}`);
    const mismatchedSnapshot: SourceSnapshot = {
      ...sourceSnapshot(`mismatch-${label}`),
      fetchedByRunId: "ssr_other_run",
    };

    await expect(
      Promise.resolve().then(() =>
        store.commitSourceSyncSuccess({
          terminalRun: terminal,
          leaseToken: `lease_mismatch_${label}`,
          snapshot: mismatchedSnapshot,
        }),
      ),
    ).rejects.toThrow("exact canonical SourceSnapshot");
    expect((await store.getSourceSyncRun(RUN_ID))?.status, label).toBe("running");
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), label).toBeUndefined();
  }
});

test("source-sync success cannot move a held Run to another Workspace", async () => {
  for (const [label, store] of await stores()) {
    const running = await claimRun(store, `lease_owner_${label}`);
    const otherWorkspaceId = `other-workspace-${label}`;
    await store.putWorkspace({ ...workspace(), id: otherWorkspaceId, handle: `other-${label}`, ownerUserId: `other-owner-${label}` });
    const terminal = { ...succeededRun(running, `owner-${label}`), workspaceId: otherWorkspaceId };
    const snapshot = { ...sourceSnapshot(`owner-${label}`), workspaceId: otherWorkspaceId };
    expect(await store.commitSourceSyncSuccess({
      terminalRun: terminal, leaseToken: `lease_owner_${label}`, snapshot,
    }), label).toEqual({ won: false, run: running });
    expect(await store.getSourceSyncRun(RUN_ID), label).toEqual(running);
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), label).toBeUndefined();
  }
});

test("postgres SourceSync success tolerates a concurrent heartbeat on the same held lease", async () => {
  const backing = await PGliteSqlClient.create();
  pgClients.push(backing);
  let armed = false;
  let interleaved = false;
  const client: SqlClient = {
    query: (statement, parameters) => backing.query(statement, parameters),
    transaction: (callback) => backing.transaction(async (transaction) => {
      const handle: SqlTransaction = {
        transaction: (nested) => transaction.transaction(nested),
        async query<Row extends Record<string, unknown>>(
          statement: string, parameters?: SqlParameters,
        ) {
          if (armed && /^update\b/iu.test(statement.trimStart()) && statement.includes("takosumi_runs")) {
            armed = false;
            interleaved = true;
            // A normal heartbeat does not change status or the held lease.
            // It must not turn an otherwise valid success into a lost-lease CAS.
            await transaction.query(
              "update takosumi_runs set heartbeat_at = 1500, run_json = jsonb_set(run_json::jsonb, '{heartbeatAt}', '1500'::jsonb) where id = $1",
              [RUN_ID],
            );
          }
          return await transaction.query<Row>(statement, parameters);
        },
      };
      return await callback(handle);
    }),
  };
  const store = new SqlOpenTofuControlStore({ client });
  const running = await claimRun(store, "same-lease-heartbeat");
  const terminal = succeededRun(running, "same-lease-commit");
  const snapshot = sourceSnapshot("same-lease-commit");
  armed = true;
  const result = await store.commitSourceSyncSuccess({ terminalRun: terminal, leaseToken: "same-lease-heartbeat", snapshot });
  expect(interleaved).toBe(true);
  expect(result).toEqual({ won: true, run: terminal });
  expect(await store.getSourceSnapshot(SNAPSHOT_ID)).toEqual(snapshot);
});

test("postgres rolls back the terminal source-sync CAS when the snapshot write fails", async () => {
  const backing = await PGliteSqlClient.create();
  pgClients.push(backing);
  const faulting = new SnapshotFailingSqlClient(backing);
  const store = new SqlOpenTofuControlStore({ client: faulting });
  const running = await claimRun(store, "lease_postgres_fault");
  const terminal = succeededRun(running, "postgres-fault");
  const snapshot = sourceSnapshot("postgres-fault");
  faulting.failNextSnapshotWrite();

  await expect(
    store.commitSourceSyncSuccess({
      terminalRun: terminal,
      leaseToken: "lease_postgres_fault",
      snapshot,
    }),
  ).rejects.toThrow("source_snapshots");

  expect(faulting.runUpdatePrecededFault).toBe(true);
  expect((await store.getSourceSyncRun(RUN_ID))?.status).toBe("running");
  expect(await store.getSourceSnapshot(SNAPSHOT_ID)).toBeUndefined();

  expect(
    (
      await store.commitSourceSyncSuccess({
        terminalRun: terminal,
        leaseToken: "lease_postgres_fault",
        snapshot,
      })
    ).won,
  ).toBe(true);
});

test("d1 rolls back the terminal source-sync CAS when the snapshot write fails", async () => {
  const db = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  const running = await claimRun(store, "lease_d1_fault");
  const terminal = succeededRun(running, "d1-fault");
  const snapshot = sourceSnapshot("d1-fault");
  await db.exec(`
    create trigger fail_source_snapshot
    before insert on source_snapshots
    begin
      select raise(abort, 'injected source snapshot write failure');
    end;
  `);

  await expect(
    store.commitSourceSyncSuccess({
      terminalRun: terminal,
      leaseToken: "lease_d1_fault",
      snapshot,
    }),
  ).rejects.toThrow("injected source snapshot write failure");

  expect((await store.getSourceSyncRun(RUN_ID))?.status).toBe("running");
  expect(await store.getSourceSnapshot(SNAPSHOT_ID)).toBeUndefined();

  await db.exec("drop trigger fail_source_snapshot");
  expect(
    (
      await store.commitSourceSyncSuccess({
        terminalRun: terminal,
        leaseToken: "lease_d1_fault",
        snapshot,
      })
    ).won,
  ).toBe(true);
});

class SnapshotFailingSqlClient implements SqlClient {
  #armed = false;
  runUpdatePrecededFault = false;

  constructor(private readonly inner: SqlClient) {}

  failNextSnapshotWrite(): void {
    this.#armed = true;
    this.runUpdatePrecededFault = false;
  }

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    return this.inner.query<Row>(sql, parameters);
  }

  transaction<T>(
    fn: (transaction: SqlTransaction) => T | Promise<T>,
  ): Promise<T> {
    return this.inner.transaction(async (transaction) => {
      let sawRunUpdate = false;
      const handle: SqlTransaction = {
        query: async <
          Row extends Record<string, unknown> = Record<string, unknown>,
        >(
          sql: string,
          parameters?: SqlParameters,
        ): Promise<SqlQueryResult<Row>> => {
          const normalized = sql.trimStart().toLowerCase();
          if (normalized.startsWith("update") && normalized.includes("runs")) {
            sawRunUpdate = true;
          }
          if (
            this.#armed &&
            normalized.startsWith("insert") &&
            normalized.includes("source_snapshots")
          ) {
            this.#armed = false;
            this.runUpdatePrecededFault = sawRunUpdate;
            throw new Error("injected source snapshot write failure");
          }
          return await transaction.query<Row>(sql, parameters);
        },
        transaction: async <Nested>(
          nested: (
            transaction: SqlTransaction,
          ) => Nested | Promise<Nested>,
        ): Promise<Nested> => await nested(handle),
      };
      return await fn(handle);
    });
  }
}
