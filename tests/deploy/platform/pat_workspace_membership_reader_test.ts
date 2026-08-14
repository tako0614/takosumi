import { expect, test } from "bun:test";

import type {
  D1Database,
  D1ExecResult,
  D1PreparedStatement,
  D1Result,
  D1Value,
} from "../../../accounts/service/src/d1-store.ts";
import { deployControlD1TableNames } from "../../../core/adapters/storage/drizzle/schema/logical.ts";
import { createCloudflareD1PatWorkspaceMembershipReader } from "../../../deploy/platform/pat-workspace-membership-reader.ts";

class CountingD1 implements D1Database {
  readonly prepared: string[] = [];
  readonly bound: D1Value[][] = [];
  allCalls = 0;
  firstCalls = 0;
  runCalls = 0;
  batchCalls = 0;
  execCalls = 0;

  constructor(readonly rows: readonly unknown[]) {}

  prepare(query: string): D1PreparedStatement {
    this.prepared.push(query);
    return new CountingStatement(this);
  }

  async batch<T = unknown>(
    _statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    this.batchCalls += 1;
    return [];
  }

  async exec(_query: string): Promise<D1ExecResult> {
    this.execCalls += 1;
    return { count: 0, duration: 0 };
  }
}

class CountingStatement implements D1PreparedStatement {
  constructor(readonly db: CountingD1) {}

  bind(...values: readonly D1Value[]): D1PreparedStatement {
    this.db.bound.push([...values]);
    return this;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    this.db.allCalls += 1;
    return { success: true, results: [...this.db.rows] as T[] };
  }

  async first<T = unknown>(_column?: string): Promise<T | null> {
    this.db.firstCalls += 1;
    return null;
  }

  async run(): Promise<D1Result> {
    this.db.runCalls += 1;
    return { success: true };
  }
}

test("the Cloudflare PAT membership reader performs one bounded exact SELECT and no writes", async () => {
  const db = new CountingD1([
    {
      id: "wsm_reader",
      workspace_id: "ws_reader",
      account_id: "tsub_reader",
      status: "active",
      record_json: JSON.stringify({
        id: "wsm_reader",
        workspaceId: "ws_reader",
        accountId: "tsub_reader",
        roles: ["owner"],
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  ]);

  const member = await createCloudflareD1PatWorkspaceMembershipReader(
    db,
  ).getMember("ws_reader", "tsub_reader");

  expect(member).toEqual({
    id: "wsm_reader",
    workspaceId: "ws_reader",
    accountId: "tsub_reader",
    roles: ["owner"],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  expect(db.prepared).toHaveLength(1);
  const sql = db.prepared[0]?.replaceAll(/\s+/gu, " ").trim() ?? "";
  expect(sql).toContain(`from ${deployControlD1TableNames.workspaceMembers}`);
  expect(sql).toContain("where workspace_id = ? and account_id = ?");
  expect(sql).toContain("limit 2");
  expect(db.bound).toEqual([["ws_reader", "tsub_reader"]]);
  expect(db.allCalls).toBe(1);
  expect(db.firstCalls).toBe(0);
  expect(db.runCalls).toBe(0);
  expect(db.batchCalls).toBe(0);
  expect(db.execCalls).toBe(0);
});

test("the Cloudflare PAT membership reader accepts zero rows and rejects duplicate or malformed evidence", async () => {
  expect(
    await createCloudflareD1PatWorkspaceMembershipReader(
      new CountingD1([]),
    ).getMember("ws_absent", "tsub_absent"),
  ).toBeUndefined();

  const validRow = {
    id: "wsm_reader",
    workspace_id: "ws_reader",
    account_id: "tsub_reader",
    status: "active",
    record_json: JSON.stringify({
      id: "wsm_reader",
      workspaceId: "ws_reader",
      accountId: "tsub_reader",
      roles: ["owner"],
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  await expect(
    createCloudflareD1PatWorkspaceMembershipReader(
      new CountingD1([validRow, validRow]),
    ).getMember("ws_reader", "tsub_reader"),
  ).rejects.toThrow("exactly one");
  await expect(
    createCloudflareD1PatWorkspaceMembershipReader(
      new CountingD1([{ ...validRow, record_json: "{" }]),
    ).getMember("ws_reader", "tsub_reader"),
  ).rejects.toThrow("malformed");
  await expect(
    createCloudflareD1PatWorkspaceMembershipReader(
      new CountingD1([{ ...validRow, account_id: "tsub_other" }]),
    ).getMember("ws_reader", "tsub_reader"),
  ).rejects.toThrow("identity");
});
