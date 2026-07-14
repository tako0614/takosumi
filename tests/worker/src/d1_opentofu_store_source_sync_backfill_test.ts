/**
 * D1 `source_sync` ledger back-fill parity with Postgres migration v42
 * (`deploy.takosumi_d1_schema_projection_columns.create`).
 *
 * Before the Source-scoped run split, `source_sync` rows were written with the
 * source id in `installation_id` (and mirrored in `run_json.sourceId`). The D1
 * schema-init only added the `source_id` column; legacy rows were left for the
 * `listSourceSyncRuns` legacy dual-read branch (`installation_id == sourceId`)
 * to find. These tests seed the old physical `runs` table before bootstrap and
 * assert that the versioned D1 schema migration normalizes those rows into
 * `source_id` (so the dual-read branch can later be dropped without silently
 * dropping history), is idempotent, and that `listSourceSyncRuns` returns the
 * back-filled rows by source id.
 */
import { expect, test } from "bun:test";

import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";
import type { D1Database } from "../../../worker/src/bindings.ts";
import type { SourceSyncRun } from "takosumi-contract/sources";

const SOURCE_ID = "src_abcdef0123456789";

type LegacySourceSyncRun = Omit<SourceSyncRun, "workspaceId"> & {
  readonly spaceId: string;
};

function legacyRunJson(
  overrides: Partial<LegacySourceSyncRun> = {},
): LegacySourceSyncRun {
  return {
    id: "ssr_0000000000000001",
    kind: "source_sync",
    spaceId: "space_1",
    sourceId: SOURCE_ID,
    url: "https://github.com/acme/repo.git",
    ref: "main",
    path: ".",
    archiveRef:
      "workspaces/space_1/sources/src_abcdef0123456789/snapshots/snap_x/source.tar.zst",
    status: "succeeded",
    createdAt: "2026-06-06T00:00:30.000Z",
    updatedAt: "2026-06-06T00:00:30.000Z",
    ...overrides,
  };
}

async function createLegacyRunsTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `create table runs (
      id text primary key,
      run_group_id text,
      space_id text not null,
      installation_id text not null,
      environment text not null,
      type text not null,
      status text not null,
      run_json text not null,
      created_at text not null default ""
    )`,
    )
    .run();
}

/**
 * Insert a row the way the pre-split writer did: the old table has no
 * `source_id`, the source id is parked in `installation_id`, and the full
 * record (with `sourceId`) is in `run_json`. Bypasses the typed store on purpose
 * to reproduce the old physical shape before bootstrap.
 */
async function insertLegacySourceSyncRow(
  db: D1Database,
  run: LegacySourceSyncRun,
  installationIdValue: string | null = run.sourceId,
): Promise<void> {
  await db
    .prepare(
      `insert into runs
        (id, run_group_id, space_id, installation_id, environment, type, status, run_json, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      run.id,
      null,
      run.spaceId,
      installationIdValue,
      "default",
      "source_sync",
      run.status,
      JSON.stringify(run),
      run.createdAt,
    )
    .run();
}

async function readRunRow(
  db: D1Database,
  id: string,
): Promise<{ source_id: string | null; installation_id: string | null }> {
  const row = await db
    .prepare(`select source_id, installation_id from runs where id = ?`)
    .bind(id)
    .first<{ source_id: string | null; installation_id: string | null }>();
  if (!row) throw new Error(`row ${id} missing`);
  return row;
}

test("d1: ensureD1OpenTofuLedgerSchema back-fills legacy source_sync source_id", async () => {
  const db = new SqliteFakeD1();
  await createLegacyRunsTable(db);

  const legacy = legacyRunJson({ id: "ssr_0000000000000001" });
  await insertLegacySourceSyncRow(db, legacy);

  // Bootstrap adds source_id, rebuilds the nullable run projection, and runs the
  // versioned source_sync back-fill.
  await ensureD1OpenTofuLedgerSchema(db);

  const after = await readRunRow(db, legacy.id);
  expect(after.source_id).toBe(SOURCE_ID);
  expect(after.installation_id).toBeNull();
});

test("d1: listSourceSyncRuns returns back-filled legacy rows by source id", async () => {
  const db = new SqliteFakeD1();
  await createLegacyRunsTable(db);

  const r1 = legacyRunJson({ id: "ssr_0000000000000001" });
  const r2 = legacyRunJson({
    id: "ssr_0000000000000002",
    createdAt: "2026-06-06T00:01:30.000Z",
  });
  const other = legacyRunJson({
    id: "ssr_0000000000000003",
    sourceId: "src_other00000000",
  });
  await insertLegacySourceSyncRow(db, r1);
  await insertLegacySourceSyncRow(db, r2);
  await insertLegacySourceSyncRow(db, other, "src_other00000000");

  await ensureD1OpenTofuLedgerSchema(db);

  const store = new CloudflareD1OpenTofuControlStore(db);
  const list = await store.listSourceSyncRuns(SOURCE_ID);
  expect(list.map((x) => x.id)).toEqual([r1.id, r2.id]);
  // The non-matching source's row stays scoped to its own source id.
  const otherList = await store.listSourceSyncRuns("src_other00000000");
  expect(otherList.map((x) => x.id)).toEqual([other.id]);
});

test("d1: source_sync back-fill prefers run_json.sourceId over installation_id", async () => {
  const db = new SqliteFakeD1();
  await createLegacyRunsTable(db);

  // run_json.sourceId is the canonical value; installation_id held a stale id.
  const run = legacyRunJson({
    id: "ssr_0000000000000004",
    sourceId: SOURCE_ID,
  });
  await insertLegacySourceSyncRow(db, run, "src_stale00000000");

  await ensureD1OpenTofuLedgerSchema(db);

  const after = await readRunRow(db, run.id);
  expect(after.source_id).toBe(SOURCE_ID);
  expect(after.installation_id).toBeNull();
});

test("d1: source_sync back-fill is idempotent and leaves current rows intact", async () => {
  const db = new SqliteFakeD1();
  await createLegacyRunsTable(db);

  // Legacy row needing back-fill.
  const legacy = legacyRunJson({ id: "ssr_0000000000000001" });
  await insertLegacySourceSyncRow(db, legacy);

  // Current-format row already written through the typed store path.
  const store = new CloudflareD1OpenTofuControlStore(db);
  const legacyCurrent = legacyRunJson({
    id: "ssr_0000000000000005",
    createdAt: "2026-06-06T00:02:00.000Z",
  });
  const { spaceId: workspaceId, ...currentFields } = legacyCurrent;
  const current: SourceSyncRun = { ...currentFields, workspaceId };
  await store.putSourceSyncRun(current);
  const currentBefore = await readRunRow(db, current.id);
  expect(currentBefore.source_id).toBe(SOURCE_ID);
  expect(currentBefore.installation_id).toBeNull();

  // Run the back-fill several times: must converge and not mutate further.
  await ensureD1OpenTofuLedgerSchema(db);
  await ensureD1OpenTofuLedgerSchema(db);
  await ensureD1OpenTofuLedgerSchema(db);

  const legacyAfter = await readRunRow(db, legacy.id);
  expect(legacyAfter.source_id).toBe(SOURCE_ID);
  expect(legacyAfter.installation_id).toBeNull();

  const currentAfter = await readRunRow(db, current.id);
  expect(currentAfter.source_id).toBe(SOURCE_ID);
  expect(currentAfter.installation_id).toBeNull();

  const list = await store.listSourceSyncRuns(SOURCE_ID);
  expect(list.map((x) => x.id)).toEqual([legacy.id, current.id]);
});
