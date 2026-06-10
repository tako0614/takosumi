/**
 * D1 `source_sync` ledger back-fill parity with Postgres migration v42
 * (`deploy.takosumi_d1_schema_projection_columns.create`).
 *
 * Before the Source-scoped run split, `source_sync` rows were written with the
 * source id in `installation_id` (and mirrored in `run_json.sourceId`). The D1
 * schema-init only added the `source_id` column; legacy rows were left for the
 * `listSourceSyncRuns` legacy dual-read branch (`installation_id == sourceId`)
 * to find. These tests assert that `ensureD1OpenTofuLedgerSchema` now normalizes
 * those rows into `source_id` (so the dual-read branch can later be dropped
 * without silently dropping history), is idempotent, and that
 * `listSourceSyncRuns` returns the back-filled rows by source id.
 */
import { expect, test } from "bun:test";

import {
  CloudflareD1OpenTofuDeploymentStore,
  ensureD1OpenTofuLedgerSchema,
} from "./d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../src/service/domains/deploy-control/sqlite_fake_d1.ts";
import type { D1Database } from "./bindings.ts";
import type { SourceSyncRun } from "takosumi-contract/sources";

const SOURCE_ID = "src_abcdef0123456789";

function legacyRunJson(overrides: Partial<SourceSyncRun> = {}): SourceSyncRun {
  return {
    id: "ssr_0000000000000001",
    kind: "source_sync",
    spaceId: "space_1",
    sourceId: SOURCE_ID,
    url: "https://github.com/acme/repo.git",
    ref: "main",
    path: ".",
    archiveObjectKey:
      "spaces/space_1/sources/src_abcdef0123456789/snapshots/snap_x/source.tar.zst",
    status: "succeeded",
    createdAt: "2026-06-06T00:00:30.000Z",
    updatedAt: "2026-06-06T00:00:30.000Z",
    ...overrides,
  };
}

/**
 * Insert a row the way the pre-split writer did: `source_id` NULL, the source id
 * parked in `installation_id`, and the full record (with `sourceId`) in
 * `run_json`. Bypasses the typed store on purpose to reproduce the old wire shape.
 */
async function insertLegacySourceSyncRow(
  db: D1Database,
  run: SourceSyncRun,
  installationIdValue: string | null = run.sourceId,
): Promise<void> {
  await db
    .prepare(
      `insert into runs
        (id, run_group_id, space_id, source_id, installation_id, environment, type, status, run_json, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      run.id,
      null,
      run.spaceId,
      null,
      installationIdValue,
      null,
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
  await ensureD1OpenTofuLedgerSchema(db);

  const legacy = legacyRunJson({ id: "ssr_0000000000000001" });
  await insertLegacySourceSyncRow(db, legacy);

  // Pre-back-fill: source_id is NULL, source id parked in installation_id.
  const before = await readRunRow(db, legacy.id);
  expect(before.source_id).toBeNull();
  expect(before.installation_id).toBe(SOURCE_ID);

  // Re-running schema init triggers the back-fill (migrate runs inside).
  await ensureD1OpenTofuLedgerSchema(db);

  const after = await readRunRow(db, legacy.id);
  expect(after.source_id).toBe(SOURCE_ID);
  expect(after.installation_id).toBeNull();
});

test("d1: listSourceSyncRuns returns back-filled legacy rows by source id", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);

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

  const store = new CloudflareD1OpenTofuDeploymentStore(db);
  const list = await store.listSourceSyncRuns(SOURCE_ID);
  expect(list.map((x) => x.id)).toEqual([r1.id, r2.id]);
  // The non-matching source's row stays scoped to its own source id.
  const otherList = await store.listSourceSyncRuns("src_other00000000");
  expect(otherList.map((x) => x.id)).toEqual([other.id]);
});

test("d1: source_sync back-fill prefers run_json.sourceId over installation_id", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);

  // run_json.sourceId is the canonical value; installation_id held a stale id.
  const run = legacyRunJson({ id: "ssr_0000000000000004", sourceId: SOURCE_ID });
  await insertLegacySourceSyncRow(db, run, "src_stale00000000");

  await ensureD1OpenTofuLedgerSchema(db);

  const after = await readRunRow(db, run.id);
  expect(after.source_id).toBe(SOURCE_ID);
  expect(after.installation_id).toBeNull();
});

test("d1: source_sync back-fill is idempotent and leaves current rows intact", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);

  // Legacy row needing back-fill.
  const legacy = legacyRunJson({ id: "ssr_0000000000000001" });
  await insertLegacySourceSyncRow(db, legacy);

  // Current-format row already written through the typed store path.
  const store = new CloudflareD1OpenTofuDeploymentStore(db);
  const current = legacyRunJson({
    id: "ssr_0000000000000005",
    createdAt: "2026-06-06T00:02:00.000Z",
  });
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
