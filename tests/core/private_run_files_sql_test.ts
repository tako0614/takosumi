import { expect, test } from "bun:test";

import {
  type PrivateRunFileRepositoryPort,
  type PrivateRunFileScope,
} from "../../core/domains/private-run-files/mod.ts";
import { PostgresPrivateRunFileRepository } from "../../core/domains/private-run-files/repository_sql.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
  SqlTransaction,
} from "../../core/adapters/storage/sql.ts";
import {
  postgresStorageMigrationStatements,
  postgresStorageTableDefinitions,
} from "../../core/adapters/storage/migrations.ts";

const scope: PrivateRunFileScope = {
  workspaceId: "workspace_sql",
  capsuleId: "capsule_sql",
  environment: "preview",
  slot: "opaque-intent-slot",
};

const runAuthority = {
  runId: "run_sql",
  executionAuthorityEpoch: 4,
  leaseToken: "lease_sql",
};

const digest1 = `sha256:${"1".repeat(64)}` as const;
const digest2 = `sha256:${"2".repeat(64)}` as const;

interface PointerRow extends Record<string, unknown> {
  readonly version: number | string;
  readonly digest: string;
  readonly blobId: string;
}

interface ReceiptRow extends PointerRow {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly slot: string;
  readonly commitId: string;
  readonly expectedVersion: number | string;
}

interface SqlState {
  workspace: { managementState: string; managementEpoch: number };
  capsule: {
    workspaceId: string;
    environment: string;
    status: string;
    executionAuthorityEpoch: number;
  };
  run: {
    workspaceId: string;
    capsuleId: string;
    kind: string;
    status: string;
    leaseToken: string | null;
    runJson: unknown;
  };
  pointers: Map<string, PointerRow>;
  receipts: Map<string, ReceiptRow>;
}

function makeClient(run: Partial<SqlState["run"]> = {}): MemorySqlClient {
  return new MemorySqlClient({
    workspace: { managementState: "active", managementEpoch: 1 },
    capsule: {
      workspaceId: scope.workspaceId,
      environment: scope.environment,
      status: "active",
      executionAuthorityEpoch: runAuthority.executionAuthorityEpoch,
    },
    run: {
      workspaceId: scope.workspaceId,
      capsuleId: scope.capsuleId,
      kind: "apply",
      status: "running",
      leaseToken: runAuthority.leaseToken,
      runJson: {
        expected: {
          capsuleExecutionAuthorityEpoch: runAuthority.executionAuthorityEpoch,
        },
      },
      ...run,
    },
    pointers: new Map(),
    receipts: new Map(),
  });
}

function pointerKey(values: readonly unknown[]) {
  return `${values[0]}\u0000${values[1]}\u0000${values[2]}\u0000${values[3]}`;
}

function receiptKey(values: readonly unknown[]) {
  return `${pointerKey(values)}\u0000${values[4]}`;
}

/**
 * Transaction-aware SQL double for adapter-query regression only. It does not
 * emulate PostgreSQL row locking or establish real atomicity/isolation proof.
 */
class MemorySqlClient implements SqlClient {
  readonly statements: string[] = [];
  rollbackCount = 0;
  loseNextCommitAck = false;
  failReceiptInsert = false;
  #state: SqlState;
  #tail: Promise<void> = Promise.resolve();

  constructor(initial: SqlState) {
    this.#state = initial;
  }

  get state(): SqlState {
    return this.#state;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    const tx = new MemorySqlTransaction(this.#state, this.statements, this);
    return await tx.query<Row>(sql, parameters);
  }

  async transaction<T>(
    fn: (transaction: SqlTransaction) => T | Promise<T>,
  ): Promise<T> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const working = structuredClone(this.#state) as SqlState;
    const tx = new MemorySqlTransaction(working, this.statements, this);
    let committed = false;
    try {
      const result = await fn(tx);
      this.#state = working;
      committed = true;
      if (this.loseNextCommitAck) {
        this.loseNextCommitAck = false;
        throw new Error("fixture lost commit acknowledgement");
      }
      return result;
    } catch (error) {
      if (!committed) this.rollbackCount += 1;
      throw error;
    } finally {
      release();
    }
  }
}

class MemorySqlTransaction implements SqlTransaction {
  constructor(
    private readonly state: SqlState,
    private readonly statements: string[],
    private readonly client: MemorySqlClient,
  ) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    this.statements.push(sql.replace(/\s+/g, " ").trim().toLowerCase());
    const values = Array.isArray(parameters) ? parameters : [];
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    let rows: Record<string, unknown>[] = [];

    if (normalized.includes("from takosumi_workspaces")) {
      if (values[0] === scope.workspaceId) rows = [{ ...this.state.workspace }];
    } else if (normalized.includes("from takosumi_capsules")) {
      if (values[0] === scope.capsuleId) rows = [{ ...this.state.capsule }];
    } else if (normalized.includes("from takosumi_runs")) {
      if (values[0] === runAuthority.runId) rows = [{ ...this.state.run }];
    } else if (normalized.includes("from takosumi_private_run_file_receipts")) {
      const row = this.state.receipts.get(receiptKey(values));
      if (row) rows = [{ ...row }];
    } else if (normalized.includes("from takosumi_private_run_file_pointers")) {
      const row = this.state.pointers.get(pointerKey(values));
      if (row) rows = [{ ...row }];
    } else if (
      normalized.startsWith("insert into takosumi_private_run_file_pointers")
    ) {
      const key = pointerKey(values.slice(0, 4));
      if (!this.state.pointers.has(key)) {
        const row: PointerRow = {
          version: 1,
          digest: values[4] as string,
          blobId: values[5] as string,
        };
        this.state.pointers.set(key, row);
        rows = [{ ...row }];
      }
    } else if (
      normalized.startsWith("update takosumi_private_run_file_pointers")
    ) {
      const key = pointerKey(values.slice(3, 7));
      const current = this.state.pointers.get(key);
      if (current?.version === values[7]) {
        const row: PointerRow = {
          version: values[0] as number,
          digest: values[1] as string,
          blobId: values[2] as string,
        };
        this.state.pointers.set(key, row);
        rows = [{ ...row }];
      }
    } else if (
      normalized.startsWith("insert into takosumi_private_run_file_receipts")
    ) {
      if (this.client.failReceiptInsert) {
        throw new Error("fixture receipt insert failure");
      }
      const key = receiptKey(values.slice(0, 5));
      if (!this.state.receipts.has(key)) {
        const row: ReceiptRow = {
          workspaceId: values[0] as string,
          capsuleId: values[1] as string,
          environment: values[2] as string,
          slot: values[3] as string,
          commitId: values[4] as string,
          expectedVersion: values[5] as number,
          version: values[6] as number,
          digest: values[7] as string,
          blobId: values[8] as string,
        };
        this.state.receipts.set(key, row);
        rows = [{ ...row }];
      }
    } else {
      throw new Error(`unhandled fixture SQL: ${normalized}`);
    }
    return { rows: rows as Row[], rowCount: rows.length };
  }

  async transaction<T>(
    fn: (transaction: SqlTransaction) => T | Promise<T>,
  ): Promise<T> {
    return await fn(this);
  }
}

function repository(client: MemorySqlClient): PrivateRunFileRepositoryPort {
  return new PostgresPrivateRunFileRepository(client);
}

test("migration 116 is additive and its declared tables are materialized", () => {
  expect(
    postgresStorageMigrationStatements.find((entry) => entry.version === 115)
      ?.id,
  ).toBe("deploy.state_recovery_run_kind.add");
  const migration = postgresStorageMigrationStatements.find(
    (entry) => entry.version === 116,
  );
  expect(migration?.id).toBe("deploy.private_run_files.add");
  expect(migration?.sql).toContain(
    "create table if not exists takosumi_private_run_file_pointers",
  );
  expect(migration?.sql).toContain(
    "create table if not exists takosumi_private_run_file_receipts",
  );
  expect(postgresStorageTableDefinitions.map((entry) => entry.name)).toContain(
    "takosumi_private_run_file_pointers",
  );
  expect(postgresStorageTableDefinitions.map((entry) => entry.name)).toContain(
    "takosumi_private_run_file_receipts",
  );
});

test("initial absent slot uses the Capsule lock before pointer insert and receipt commit", async () => {
  const client = makeClient();
  const store = repository(client);
  const result = await store.commitPointer({
    scope,
    ...runAuthority,
    expectedVersion: 0,
    commitId: "commit-1",
    digest: digest1,
    blobId: "blob-1",
  });
  expect(result.kind).toBe("committed");
  expect(client.state.pointers.size).toBe(1);
  expect(client.state.receipts.size).toBe(1);
  const locks = client.statements.slice(0, 3);
  expect(locks[0]).toContain("from takosumi_workspaces");
  expect(locks[0]).toContain("for update");
  expect(locks[1]).toContain("from takosumi_capsules");
  expect(locks[1]).toContain("for update");
  expect(locks[2]).toContain("from takosumi_runs");
  expect(locks[2]).toContain("for update");
});

test("authority fencing accepts only the canonical captured epoch for Plan and Apply Run kinds", async () => {
  const cases = [
    { kind: "plan", runJson: { capsuleExecutionAuthorityEpoch: 4 } },
    { kind: "destroy_plan", runJson: { capsuleExecutionAuthorityEpoch: 4 } },
    { kind: "drift_check", runJson: { capsuleExecutionAuthorityEpoch: 4 } },
    {
      kind: "apply",
      runJson: { expected: { capsuleExecutionAuthorityEpoch: 4 } },
    },
    {
      kind: "destroy_apply",
      runJson: { expected: { capsuleExecutionAuthorityEpoch: 4 } },
    },
  ] as const;

  for (const run of cases) {
    const client = makeClient(run);
    await expect(
      repository(client).lookupReceipt({
        scope,
        ...runAuthority,
        commitId: `canonical-${run.kind}`,
      }),
    ).resolves.toEqual({ kind: "absent" });
  }
});

test("authority fencing rejects missing, malformed, mismatched, and generic Run epochs", async () => {
  const cases: readonly Partial<SqlState["run"]>[] = [
    { kind: "plan", runJson: {} },
    { kind: "plan", runJson: { capsuleExecutionAuthorityEpoch: "4" } },
    { kind: "plan", runJson: { capsuleExecutionAuthorityEpoch: 4.5 } },
    { kind: "plan", runJson: { capsuleExecutionAuthorityEpoch: 3 } },
    { kind: "apply", runJson: { expected: {} } },
    {
      kind: "apply",
      runJson: { expected: { capsuleExecutionAuthorityEpoch: 3 } },
    },
    { kind: "backup", runJson: { status: "running" } },
    { kind: "restore", runJson: { status: "running" } },
  ];

  for (const run of cases) {
    const client = makeClient(run);
    await expect(
      repository(client).lookupReceipt({
        scope,
        ...runAuthority,
        commitId: "not-authorized",
      }),
    ).resolves.toEqual({ kind: "authority_rejected" });
  }
});

test("concurrent first-slot commits have one version-zero winner", async () => {
  const client = makeClient();
  const store = repository(client);
  const results = await Promise.all([
    store.commitPointer({
      scope,
      ...runAuthority,
      expectedVersion: 0,
      commitId: "race-a",
      digest: digest1,
      blobId: "blob-a",
    }),
    store.commitPointer({
      scope,
      ...runAuthority,
      expectedVersion: 0,
      commitId: "race-b",
      digest: digest2,
      blobId: "blob-b",
    }),
  ]);
  expect(results.map((result) => result.kind).sort()).toEqual([
    "committed",
    "conflict",
  ]);
  expect(client.state.pointers.size).toBe(1);
  expect(client.state.receipts.size).toBe(1);
});

test("exact receipt replay returns the first receipt after a later version", async () => {
  const client = makeClient();
  const store = repository(client);
  const original = await store.commitPointer({
    scope,
    ...runAuthority,
    expectedVersion: 0,
    commitId: "original",
    digest: digest1,
    blobId: "blob-1",
  });
  await store.commitPointer({
    scope,
    ...runAuthority,
    expectedVersion: 1,
    commitId: "next",
    digest: digest2,
    blobId: "blob-2",
  });
  const replay = await store.commitPointer({
    scope,
    ...runAuthority,
    expectedVersion: 0,
    commitId: "original",
    digest: digest1,
    blobId: "unreferenced-retry",
  });
  expect(replay).toEqual({
    kind: "replayed",
    receipt: original.kind === "committed" ? original.receipt : undefined,
  });
  expect(
    client.state.pointers.get(
      pointerKey([
        scope.workspaceId,
        scope.capsuleId,
        scope.environment,
        scope.slot,
      ]),
    )?.version,
  ).toBe(2);
});

test("workspace drain, Capsule drift and stale Run identity or lease reject without writes", async () => {
  const cases: readonly ((client: MemorySqlClient) => void)[] = [
    (client) => {
      client.state.workspace.managementState = "draining";
    },
    (client) => {
      client.state.capsule.executionAuthorityEpoch += 1;
    },
    (client) => {
      client.state.capsule.environment = "production";
    },
    (client) => {
      client.state.run.workspaceId = "foreign-workspace";
    },
    (client) => {
      client.state.run.capsuleId = "foreign-capsule";
    },
    (client) => {
      client.state.run.kind = "source_sync";
    },
    (client) => {
      client.state.run.status = "queued";
    },
    (client) => {
      client.state.run.leaseToken = "stale-lease";
    },
  ];
  for (const mutate of cases) {
    const client = makeClient();
    mutate(client);
    const result = await repository(client).commitPointer({
      scope,
      ...runAuthority,
      expectedVersion: 0,
      commitId: "fenced",
      digest: digest1,
      blobId: "blob-1",
    });
    expect(result.kind).toBe("authority_rejected");
    expect(client.state.pointers.size).toBe(0);
    expect(client.state.receipts.size).toBe(0);
  }

  const wrongRunClient = makeClient();
  const wrongRun = await repository(wrongRunClient).commitPointer({
    scope,
    ...runAuthority,
    runId: "other-run",
    expectedVersion: 0,
    commitId: "wrong-run",
    digest: digest1,
    blobId: "blob-1",
  });
  expect(wrongRun.kind).toBe("authority_rejected");
  expect(wrongRunClient.state.pointers.size).toBe(0);
  expect(wrongRunClient.state.receipts.size).toBe(0);
});

test("receipt lookup locks and fences Workspace, Capsule, and exact Run before reading history", async () => {
  const cases: readonly ((client: MemorySqlClient) => void)[] = [
    (client) => {
      client.state.workspace.managementState = "draining";
    },
    (client) => {
      client.state.capsule.executionAuthorityEpoch += 1;
    },
    (client) => {
      client.state.capsule.environment = "production";
    },
    (client) => {
      client.state.run.workspaceId = "foreign-workspace";
    },
    (client) => {
      client.state.run.capsuleId = "foreign-capsule";
    },
    (client) => {
      client.state.run.kind = "unknown";
    },
    (client) => {
      client.state.run.status = "queued";
    },
    (client) => {
      client.state.run.leaseToken = "stale-lease";
    },
  ];
  for (const mutate of cases) {
    const client = makeClient();
    mutate(client);
    const result = await repository(client).lookupReceipt({
      scope,
      ...runAuthority,
      commitId: "receipt-fence",
    });
    expect(result.kind).toBe("authority_rejected");
    expect(
      client.statements.some((statement) =>
        statement.includes("from takosumi_private_run_file_receipts"),
      ),
    ).toBe(false);
  }

  const wrongRunClient = makeClient();
  const wrongRun = await repository(wrongRunClient).lookupReceipt({
    scope,
    ...runAuthority,
    runId: "other-run",
    commitId: "receipt-fence",
  });
  expect(wrongRun.kind).toBe("authority_rejected");
  expect(wrongRunClient.statements).toHaveLength(3);
});

test("receipt insert failure rolls the pointer update back", async () => {
  const client = makeClient();
  client.failReceiptInsert = true;
  const result = await repository(client).commitPointer({
    scope,
    ...runAuthority,
    expectedVersion: 0,
    commitId: "rollback",
    digest: digest1,
    blobId: "blob-1",
  });
  expect(result.kind).toBe("unknown");
  expect(client.rollbackCount).toBe(1);
  expect(client.state.pointers.size).toBe(0);
  expect(client.state.receipts.size).toBe(0);
});

test("lost commit ACK resolves from the durable receipt without a second write", async () => {
  const client = makeClient();
  client.loseNextCommitAck = true;
  const store = repository(client);
  const uncertain = await store.commitPointer({
    scope,
    ...runAuthority,
    expectedVersion: 0,
    commitId: "lost-ack",
    digest: digest1,
    blobId: "blob-1",
  });
  expect(uncertain.kind).toBe("unknown");
  const receipt = await store.lookupReceipt({
    scope,
    ...runAuthority,
    commitId: "lost-ack",
  });
  expect(receipt.kind).toBe("found");
  if (receipt.kind === "found") expect(receipt.receipt.version).toBe(1);
  expect(client.state.pointers.size).toBe(1);
});
