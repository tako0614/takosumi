import { expect, test } from "bun:test";
import {
  ensureD1OpenTofuLedgerSchema,
  verifyD1OpenTofuLedgerSchemaPredeployed,
} from "../../../worker/src/d1_opentofu_store.ts";
import { D1PrivateRunFileRepository } from "../../../worker/src/d1_private_run_file_repository.ts";
import type { D1Database } from "../../../worker/src/bindings.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const scope = {
  workspaceId: "private_ws",
  capsuleId: "private_capsule",
  environment: "production",
  slot: "intent",
} as const;
const authority = {
  scope,
  runId: "private_plan",
  executionAuthorityEpoch: 3,
  leaseToken: "private_lease",
} as const;
const digestA = `sha256:${"a".repeat(64)}` as const;
const digestB = `sha256:${"b".repeat(64)}` as const;

async function seedPrivateFileAuthority(db: D1Database): Promise<void> {
  await db.prepare(`insert into workspaces
    (id, handle, record_json, created_at, updated_at)
    values (?, ?, '{}', '2026-10-12', '2026-10-12')`)
    .bind(scope.workspaceId, "private-workspace").run();
  await db.prepare(`insert into capsules
    (id, space_id, project_id, name, slug, install_config_id,
     environment, status, record_json, created_at, updated_at,
     execution_authority_epoch)
    values (?, ?, ?, ?, ?, ?, ?, 'active', '{}', '2026-10-12',
      '2026-10-12', ?)`)
    .bind(
      scope.capsuleId,
      scope.workspaceId,
      "private_project",
      "private-capsule",
      "private-capsule",
      "private_install",
      scope.environment,
      authority.executionAuthorityEpoch,
    ).run();
  await db.prepare(`insert into runs
    (id, space_id, installation_id, environment, type, status,
     lease_token, run_json, created_at)
    values (?, ?, ?, ?, 'plan', 'running', ?, ?, '2026-10-12')`)
    .bind(
      authority.runId,
      scope.workspaceId,
      scope.capsuleId,
      scope.environment,
      authority.leaseToken,
      JSON.stringify({
        id: authority.runId,
        workspaceId: scope.workspaceId,
        capsuleId: scope.capsuleId,
        status: "running",
        capsuleExecutionAuthorityEpoch: authority.executionAuthorityEpoch,
        workspaceManagementAuthority: {
          workspaceId: scope.workspaceId,
          managementState: "active",
          managementEpoch: 1,
        },
      }),
    )
    .run();
}

test("v70 is additive and predeployed verification rejects v69", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db, { throughMigrationVersion: 69 });
  await expect(verifyD1OpenTofuLedgerSchemaPredeployed(db)).rejects.toThrow();
  const prior = await db.prepare(`select name from sqlite_master
    where name = 'private_run_file_pointers'`).first();
  expect(prior).toBeNull();
  await ensureD1OpenTofuLedgerSchema(db);
  await verifyD1OpenTofuLedgerSchemaPredeployed(db);
  const receipt = await db.prepare(`select name from sqlite_master
    where name = 'private_run_file_receipts'`).first();
  expect(receipt).not.toBeNull();
  const ledger = await db.prepare(`select version from schema_migrations
    where version = 70`).first<{ version: number }>();
  expect(ledger?.version).toBe(70);
});

test("D1 scoped read, commit, advanced-pointer replay and current lease fence", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  await seedPrivateFileAuthority(db);
  const repo = new D1PrivateRunFileRepository(db);
  expect(await repo.readPointer(authority)).toEqual({ kind: "absent" });
  const first = {
    ...authority,
    expectedVersion: 0,
    commitId: "first",
    digest: digestA,
    blobId: "blob_a",
  };
  const committed = await repo.commitPointer(first);
  expect(committed.kind).toBe("committed");
  expect(await repo.readPointer(authority)).toEqual({
    kind: "present",
    pointer: { version: 1, digest: digestA, blobId: "blob_a" },
  });
  expect((await repo.commitPointer({ ...first, expectedVersion: 1 })).kind)
    .toBe("conflict");
  expect((await repo.commitPointer({ ...first, digest: digestB })).kind).toBe(
    "conflict",
  );
  expect(
    (await repo.commitPointer({
      ...first,
      expectedVersion: 1,
      commitId: "second",
      digest: digestB,
      blobId: "blob_b",
    })).kind,
  ).toBe("committed");
  const replay = await repo.commitPointer(first);
  expect(replay).toEqual({
    kind: "replayed",
    receipt: (committed as {
      readonly receipt: unknown;
    }).receipt,
  });
  await db.prepare(`update runs set lease_token = 'replacement'
    where id = ?`).bind(authority.runId).run();
  expect(await repo.readPointer(authority)).toEqual({
    kind: "authority_rejected",
  });
  expect(await repo.lookupReceipt({ ...authority, commitId: "first" })).toEqual(
    {
      kind: "authority_rejected",
    },
  );
  expect(await repo.commitPointer(first)).toEqual({
    kind: "authority_rejected",
  });
});

test("D1 existing leased Plan settles its private slot during Workspace drain", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  await seedPrivateFileAuthority(db);
  const repo = new D1PrivateRunFileRepository(db);
  const first = {
    ...authority,
    expectedVersion: 0,
    commitId: "before_drain",
    digest: digestA,
    blobId: "blob_a",
  };
  const committed = await repo.commitPointer(first);
  expect(committed.kind).toBe("committed");
  await db.prepare(`update workspaces set management_state = 'draining',
    management_epoch = 2 where id = ?`).bind(scope.workspaceId).run();

  expect(await repo.readPointer(authority)).toEqual({
    kind: "present",
    pointer: { version: 1, digest: digestA, blobId: "blob_a" },
  });
  expect(await repo.lookupReceipt({ ...authority, commitId: first.commitId }))
    .toEqual({
      kind: "found",
      receipt: (committed as { readonly receipt: unknown }).receipt,
    });
  expect((await repo.commitPointer(first)).kind).toBe("replayed");
  expect(
    (await repo.commitPointer({
      ...authority,
      expectedVersion: 1,
      commitId: "during_drain",
      digest: digestB,
      blobId: "blob_b",
    })).kind,
  )
    .toBe("committed");

  await db.prepare(`update runs set lease_token = 'replacement' where id = ?`)
    .bind(authority.runId).run();
  expect(await repo.lookupReceipt({ ...authority, commitId: first.commitId }))
    .toEqual({ kind: "authority_rejected" });
  await db.prepare(`update runs set lease_token = ? where id = ?`)
    .bind(authority.leaseToken, authority.runId).run();
  await db.prepare(`update runs set status = 'succeeded' where id = ?`)
    .bind(authority.runId).run();
  expect(await repo.readPointer(authority)).toEqual({
    kind: "authority_rejected",
  });
  await db.prepare(`update runs set status = 'running' where id = ?`)
    .bind(authority.runId).run();
  await db.prepare(
    `update capsules set execution_authority_epoch = 4 where id = ?`,
  )
    .bind(scope.capsuleId).run();
  expect(await repo.readPointer(authority)).toEqual({
    kind: "authority_rejected",
  });
  await db.prepare(
    `update capsules set execution_authority_epoch = 3 where id = ?`,
  )
    .bind(scope.capsuleId).run();
  await db.prepare(
    `update workspaces set management_state = 'frozen' where id = ?`,
  )
    .bind(scope.workspaceId).run();
  expect(await repo.commitPointer(first)).toEqual({
    kind: "authority_rejected",
  });
  await db.prepare(
    `update workspaces set management_state = 'released' where id = ?`,
  )
    .bind(scope.workspaceId).run();
  expect(await repo.readPointer(authority)).toEqual({
    kind: "authority_rejected",
  });
});

test("D1 drain rejects missing, misbound or non-original Run authority", async () => {
  for (
    const original of [
      undefined,
      { workspaceId: "foreign", managementState: "active", managementEpoch: 1 },
      {
        workspaceId: scope.workspaceId,
        managementState: "draining",
        managementEpoch: 1,
      },
      {
        workspaceId: scope.workspaceId,
        managementState: "active",
        managementEpoch: "1",
      },
      {
        workspaceId: scope.workspaceId,
        managementState: "active",
        managementEpoch: 2,
      },
    ]
  ) {
    const db = new SqliteFakeD1();
    await ensureD1OpenTofuLedgerSchema(db);
    await seedPrivateFileAuthority(db);
    await db.prepare(`update runs set run_json = ? where id = ?`).bind(
      JSON.stringify({
        id: authority.runId,
        workspaceId: scope.workspaceId,
        capsuleId: scope.capsuleId,
        status: "running",
        capsuleExecutionAuthorityEpoch: authority.executionAuthorityEpoch,
        ...(original === undefined
          ? {}
          : { workspaceManagementAuthority: original }),
      }),
      authority.runId,
    ).run();
    await db.prepare(`update workspaces set management_state = 'draining',
      management_epoch = 2 where id = ?`).bind(scope.workspaceId).run();
    const repo = new D1PrivateRunFileRepository(db);
    expect(await repo.readPointer(authority)).toEqual({
      kind: "authority_rejected",
    });
    expect(
      await repo.commitPointer({
        ...authority,
        expectedVersion: 0,
        commitId: "denied",
        digest: digestA,
        blobId: "blob_denied",
      }),
    )
      .toEqual({ kind: "authority_rejected" });
  }
});

test("D1 absent-slot races do not mint a same-content losing receipt", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  await seedPrivateFileAuthority(db);
  const repo = new D1PrivateRunFileRepository(db);
  const first = {
    ...authority,
    expectedVersion: 0,
    commitId: "winner",
    digest: digestA,
    blobId: "same_blob",
  };
  const second = { ...first, commitId: "loser" };
  const outcomes = await Promise.all([
    repo.commitPointer(first),
    repo.commitPointer(second),
  ]);
  expect(outcomes.filter((item) => item.kind === "committed")).toHaveLength(1);
  expect(
    (await db.prepare(`select count(*) as count from private_run_file_receipts`)
      .first<{ count: number }>())?.count,
  ).toBe(1);
  expect(
    (await db.prepare(`select version from private_run_file_pointers`)
      .first<{ version: number }>())?.version,
  ).toBe(1);
});

test("D1 unknown batch ACK resolves exact receipt without a second mutation", async () => {
  const raw = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(raw);
  await seedPrivateFileAuthority(raw);
  let batches = 0;
  const lostAck: D1Database = {
    prepare: (query) => raw.prepare(query),
    batch: async (statements) => {
      batches++;
      await raw.batch(statements);
      throw new Error("ACK lost after commit");
    },
  };
  const repo = new D1PrivateRunFileRepository(lostAck);
  const request = {
    ...authority,
    expectedVersion: 0,
    commitId: "lost_ack",
    digest: digestA,
    blobId: "blob_a",
  };
  expect((await repo.commitPointer(request)).kind).toBe("replayed");
  expect(batches).toBe(1);
  expect((await repo.commitPointer(request)).kind).toBe("replayed");
  expect(batches).toBe(1);
  expect(
    (await raw.prepare(
      `select count(*) as count from private_run_file_receipts`,
    )
      .first<{ count: number }>())?.count,
  ).toBe(1);
});

test("D1 captured Apply epoch and Workspace drain fence every operation", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  await seedPrivateFileAuthority(db);
  await db.prepare(`update runs set type = 'apply', run_json = ? where id = ?`)
    .bind(
      JSON.stringify({
        id: authority.runId,
        workspaceId: scope.workspaceId,
        capsuleId: scope.capsuleId,
        status: "running",
        expected: { capsuleExecutionAuthorityEpoch: 3 },
      }),
      authority.runId,
    ).run();
  const repo = new D1PrivateRunFileRepository(db);
  expect(await repo.readPointer(authority)).toEqual({ kind: "absent" });
  await db.prepare(`update capsules set execution_authority_epoch = 4
    where id = ?`).bind(scope.capsuleId).run();
  expect(await repo.readPointer(authority)).toEqual({
    kind: "authority_rejected",
  });
  await db.prepare(`update capsules set execution_authority_epoch = 3
    where id = ?`).bind(scope.capsuleId).run();
  await db.prepare(`update workspaces set management_state = 'draining'
    where id = ?`).bind(scope.workspaceId).run();
  expect(
    await repo.commitPointer({
      ...authority,
      expectedVersion: 0,
      commitId: "draining",
      digest: digestA,
      blobId: "blob_a",
    }),
  ).toEqual({
    kind: "authority_rejected",
  });
});

test("D1 refuses foreign scope and Run kinds without a captured epoch", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  await seedPrivateFileAuthority(db);
  const repo = new D1PrivateRunFileRepository(db);
  expect(
    await repo.readPointer({
      ...authority,
      scope: {
        ...scope,
        workspaceId: "foreign_workspace",
      },
    }),
  ).toEqual({ kind: "authority_rejected" });
  expect(
    await repo.lookupReceipt({
      ...authority,
      commitId: "unknown",
      scope: { ...scope, environment: "staging" },
    }),
  ).toEqual({
    kind: "authority_rejected",
  });
  await db.prepare(`update runs set type = 'backup' where id = ?`)
    .bind(authority.runId).run();
  expect(await repo.readPointer(authority)).toEqual({
    kind: "authority_rejected",
  });
  expect(
    await repo.commitPointer({
      ...authority,
      expectedVersion: 0,
      commitId: "forged",
      digest: digestA,
      blobId: "blob",
    }),
  ).toEqual({
    kind: "authority_rejected",
  });
  expect(
    (await db.prepare(`select count(*) as count
    from private_run_file_receipts`).first<{ count: number }>())?.count,
  ).toBe(0);
});
