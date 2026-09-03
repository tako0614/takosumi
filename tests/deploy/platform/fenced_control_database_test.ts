import { expect, test } from "bun:test";

import {
  SqliteControlD1Database,
  buildControlD1SchemaPlan,
} from "../../../deploy/platform/control_d1_schema.ts";
import {
  fenceControlDatabase,
  fenceControlDatabaseReads,
} from "../../../deploy/platform/fenced-control-database.ts";
import { createCloudflareD1PatWorkspaceMembershipReader } from "../../../deploy/platform/pat-workspace-membership-reader.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
import { acquireControlD1MaintenanceFence } from "../../../worker/src/d1_schema_maintenance.ts";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";

const NOW = "2026-07-16T00:00:00.000Z";
const SOURCE_COMMIT = "a".repeat(40);
const WORKSPACE_ID = "ws_fenced";
const SUBJECT = "tsub_fenced" as TakosumiSubject;

async function seedMembership(database: SqliteControlD1Database): Promise<void> {
  await ensureD1OpenTofuLedgerSchema(database);
  await database
    .prepare(
      `insert into workspace_members
         (id, workspace_id, account_id, status, record_json, created_at, updated_at)
       values (?, ?, ?, 'active', ?, ?, ?)`,
    )
    .bind(
      "wsm_fenced",
      WORKSPACE_ID,
      SUBJECT,
      JSON.stringify({
        id: "wsm_fenced",
        workspaceId: WORKSPACE_ID,
        accountId: SUBJECT,
        roles: ["owner"],
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
      }),
      NOW,
      NOW,
    )
    .run();
}

test("the bounded PAT membership reader refuses while the operator holds the control maintenance fence", async () => {
  const database = new SqliteControlD1Database();
  try {
    await seedMembership(database);
    const reader = createCloudflareD1PatWorkspaceMembershipReader(
      fenceControlDatabase(database),
    );

    // Before the fence: the bounded read is the authority it has always been.
    expect(await reader.getMember(WORKSPACE_ID, SUBJECT)).toMatchObject({
      workspaceId: WORKSPACE_ID,
      accountId: SUBJECT,
      status: "active",
      roles: ["owner"],
    });

    const plan = await buildControlD1SchemaPlan();
    await acquireControlD1MaintenanceFence(
      database,
      {
        sourceCommit: SOURCE_COMMIT,
        manifestDigest: plan.manifestDigest,
        environment: "test",
      },
      NOW,
    );

    // The defect this closes: PAT authorization used to keep granting scopes
    // off a half-migrated `workspace_members` table while every store-mediated
    // request was already refusing with the same code.
    await expect(reader.getMember(WORKSPACE_ID, SUBJECT)).rejects.toThrow(
      "maintenance_fence_active",
    );
  } finally {
    database.close();
  }
});

test("the fenced control binding is wrapped once per binding and never mutates", async () => {
  const database = new SqliteControlD1Database();
  try {
    await seedMembership(database);
    expect(fenceControlDatabase(database)).toBe(fenceControlDatabase(database));

    const fenced = fenceControlDatabase(database);
    expect(Object.keys(fenced)).toEqual(["prepare"]);
    const statement = fenced
      .prepare("select id from workspace_members where workspace_id = ?")
      .bind(WORKSPACE_ID);
    expect(Object.keys(statement).sort()).toEqual(["all", "bind"]);
    expect((await statement.all()).results).toHaveLength(1);
  } finally {
    database.close();
  }
});

test("a held fence refuses before any application row is read", async () => {
  const database = new SqliteControlD1Database();
  try {
    await seedMembership(database);
    let applicationReads = 0;
    const counting = {
      prepare(_query: string) {
        const statement = {
          bind(..._values: readonly unknown[]) {
            return statement;
          },
          async all<T = unknown>() {
            applicationReads += 1;
            return { success: true, results: [] as T[] };
          },
        };
        return statement;
      },
    };
    const reader = createCloudflareD1PatWorkspaceMembershipReader(
      fenceControlDatabaseReads(database, counting),
    );
    const plan = await buildControlD1SchemaPlan();
    await acquireControlD1MaintenanceFence(
      database,
      {
        sourceCommit: SOURCE_COMMIT,
        manifestDigest: plan.manifestDigest,
        environment: "test",
      },
      NOW,
    );
    await expect(reader.getMember(WORKSPACE_ID, SUBJECT)).rejects.toThrow(
      "maintenance_fence_active",
    );
    // Durable evidence first: the fence is not an after-the-fact filter on rows
    // that were already read out of a half-migrated table.
    expect(applicationReads).toBe(0);
  } finally {
    database.close();
  }
});
