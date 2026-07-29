import { expect, test } from "bun:test";

import {
  createD1InterfaceStores,
  createSqlInterfaceStores,
  InterfaceService,
} from "../../../../core/domains/interfaces/mod.ts";
import { postgresStorageMigrationStatements } from "../../../../core/adapters/storage/migrations.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
  SqlTransaction,
} from "../../../../core/adapters/storage/sql.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import type { D1PreparedStatement } from "../../../../worker/src/bindings.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import {
  PGliteSqlClient,
  splitSqlStatements,
} from "../../../helpers/deploy-control/pglite_sql_client.ts";

const NOW = "2026-07-29T12:00:00.000Z";

class CountingD1 extends SqliteFakeD1 {
  prepareCount = 0;
  writeCount = 0;

  override prepare(query: string): D1PreparedStatement {
    this.prepareCount += 1;
    if (
      /^\s*(?:insert|update|delete|replace|create|alter|drop)\b/iu.test(query)
    ) {
      this.writeCount += 1;
    }
    return super.prepare(query);
  }

  resetCounts(): void {
    this.prepareCount = 0;
    this.writeCount = 0;
  }
}

class PlanningD1 extends CountingD1 {
  authorizedReadSql: string | undefined;

  override prepare(query: string): D1PreparedStatement {
    if (/^\s*select i\.record_json from interfaces i\b/iu.test(query)) {
      this.authorizedReadSql = query;
    }
    return super.prepare(query);
  }

  async authorizedReadPlan(): Promise<string> {
    if (!this.authorizedReadSql) {
      throw new Error("authorized Interface read was not observed");
    }
    const parameters = Array.from(
      { length: this.authorizedReadSql.match(/\?/gu)?.length ?? 0 },
      () => null,
    );
    const plan = await super
      .prepare(`explain query plan ${this.authorizedReadSql}`)
      .bind(...parameters)
      .all<{ readonly detail: string }>();
    return (plan.results ?? []).map((row) => row.detail).join("\n");
  }
}

class PlanningSqlClient implements SqlClient {
  authorizedRead:
    | {
        readonly sql: string;
        readonly parameters?: SqlParameters;
      }
    | undefined;

  constructor(readonly base: SqlClient) {}

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    if (/^\s*select i\.record_json from takosumi_interfaces i\b/iu.test(sql)) {
      this.authorizedRead = {
        sql,
        ...(parameters === undefined ? {} : { parameters }),
      };
    }
    return this.base.query<Row>(sql, parameters);
  }

  transaction<T>(
    fn: (transaction: SqlTransaction) => T | Promise<T>,
  ): Promise<T> {
    return this.base.transaction(fn);
  }
}

async function seedAuthorizedLaunchers(
  service: InterfaceService,
  count: number,
  idPrefix: string,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const iface = await service.create({
      workspaceId: "workspace_page",
      name: `${idPrefix}-${String(index).padStart(3, "0")}`,
      ownerRef: { kind: "Capsule", id: `${idPrefix}_${index}` },
      spec: {
        type: "interface.ui.surface",
        version: "1",
        document: { launcher: true },
        inputs: {
          url: {
            source: "literal",
            value: `https://${idPrefix}-${index}.example.test`,
          },
        },
        access: { visibility: "workspace" },
      },
    });
    await service.createBinding(iface.metadata.id, {
      subjectRef: { kind: "Principal", id: "principal_page" },
      permissions: ["ui.open"],
      delivery: { type: "none" },
    });
  }
}

test("authorized UI-surface pages stay one read and clamp 1/50/100/over-limit", async () => {
  const db = new CountingD1();
  await ensureD1OpenTofuLedgerSchema(db);
  let sequence = 0;
  const service = new InterfaceService({
    stores: createD1InterfaceStores(db),
    now: () => NOW,
    newId: (prefix) => `${prefix}_${String(++sequence).padStart(4, "0")}`,
  });

  for (let index = 0; index < 101; index += 1) {
    const iface = await service.create({
      workspaceId: "workspace_page",
      name: `launcher-${String(index).padStart(3, "0")}`,
      ownerRef: { kind: "Capsule", id: `capsule_${index}` },
      spec: {
        type: "interface.ui.surface",
        version: "1",
        document: { launcher: true },
        inputs: {
          url: {
            source: "literal",
            value: `https://app-${index}.example.test`,
          },
        },
        access: { visibility: "workspace" },
      },
    });
    await service.createBinding(iface.metadata.id, {
      subjectRef: { kind: "Principal", id: "principal_page" },
      permissions: ["ui.open"],
      delivery: { type: "none" },
    });
  }

  for (const [requested, expected] of [
    [1, 1],
    [50, 50],
    [100, 100],
    [1_000, 100],
  ] as const) {
    db.resetCounts();
    const page =
      await service.listAuthorizedUiSurfaceCandidatesForPrincipalPage(
        { workspaceId: "workspace_page", phase: "Resolved" },
        "principal_page",
        "ui.open",
        { limit: requested },
      );
    expect(page.items).toHaveLength(expected);
    expect(page.nextCursor).toBeString();
    expect(db.prepareCount).toBe(1);
    expect(db.writeCount).toBe(0);
  }

  db.resetCounts();
  const first = await service.listAuthorizedUiSurfaceCandidatesForPrincipalPage(
    { workspaceId: "workspace_page", phase: "Resolved" },
    "principal_page",
    "ui.open",
    { limit: 100 },
  );
  const second =
    await service.listAuthorizedUiSurfaceCandidatesForPrincipalPage(
      { workspaceId: "workspace_page", phase: "Resolved" },
      "principal_page",
      "ui.open",
      { limit: 100, cursor: first.nextCursor },
    );
  expect(second.items).toHaveLength(1);
  expect(second.nextCursor).toBeUndefined();
  expect(db.prepareCount).toBe(2);
  expect(db.writeCount).toBe(0);
});

test("D1 large-Workspace authorization uses both cursor and current-Binding indexes", async () => {
  const db = new PlanningD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const insert = db.prepare(
    `insert into interfaces (
       id, workspace_id, owner_kind, owner_id, name, interface_type, phase,
       generation, resolved_revision, record_json, created_at, updated_at
     ) values (?, ?, 'Workspace', ?, ?, 'opaque.noise', 'Resolved',
               1, 1, ?, ?, ?)`,
  );
  for (let index = 0; index < 5_000; index += 1) {
    const suffix = String(index).padStart(5, "0");
    await insert
      .bind(
        `if_noise_${suffix}`,
        "workspace_page",
        `workspace_noise_${suffix}`,
        `noise-${suffix}`,
        '{"spec":{"version":"1","document":{}}}',
        `2026-07-28T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        NOW,
      )
      .run();
  }
  let sequence = 0;
  const service = new InterfaceService({
    stores: createD1InterfaceStores(db),
    now: () => NOW,
    newId: (prefix) => `${prefix}_plan_${String(++sequence).padStart(4, "0")}`,
  });
  await seedAuthorizedLaunchers(service, 101, "d1-plan");

  db.resetCounts();
  const page = await service.listAuthorizedUiSurfaceCandidatesForPrincipalPage(
    { workspaceId: "workspace_page", phase: "Resolved" },
    "principal_page",
    "ui.open",
    { limit: 100 },
  );

  expect(page.items).toHaveLength(100);
  expect(page.nextCursor).toBeString();
  expect(db.prepareCount).toBe(1);
  expect(db.writeCount).toBe(0);
  const plan = await db.authorizedReadPlan();
  expect(plan).toContain("interfaces_authorized_page_idx");
  expect(plan).toContain("interface_bindings_authorized_current_idx");
  expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  expect(plan).not.toMatch(/\bSCAN i\b/u);
});

test("Postgres large-Workspace authorization uses both cursor and current-Binding indexes", async () => {
  const base = await PGliteSqlClient.create();
  try {
    await base.exec(
      `insert into takosumi_interfaces (
         id, workspace_id, owner_kind, owner_id, name, interface_type, phase,
         generation, resolved_revision, record_json, created_at, updated_at
       )
       select 'if_noise_' || lpad(value::text, 5, '0'),
              'workspace_page', 'Capsule',
              'capsule_noise_' || lpad(value::text, 5, '0'),
              'noise-' || lpad(value::text, 5, '0'),
              'interface.ui.surface', 'Resolved', 1, 1,
              '{"spec":{"version":"1","document":{}}}'::jsonb,
              '2026-07-28T00:00:00.000Z', '${NOW}'
       from generate_series(1, 5000) value`,
    );
    await base.exec(
      `insert into takosumi_interface_bindings (
         id, workspace_id, interface_id, subject_kind, subject_id, phase,
         generation, record_json, created_at, updated_at
       )
       select 'ifbind_noise_' || lpad(value::text, 5, '0'),
              'workspace_page',
              'if_noise_' || lpad(value::text, 5, '0'),
              'Principal', 'principal_noise', 'Ready', 1,
              jsonb_build_object(
                'spec', jsonb_build_object('permissions', '[]'::jsonb),
                'status', jsonb_build_object('observedInterfaceRevision', 1)
              ),
              '2026-07-28T00:00:00.000Z', '${NOW}'
       from generate_series(1, 5000) value`,
    );
    const client = new PlanningSqlClient(base);
    let sequence = 0;
    const service = new InterfaceService({
      stores: createSqlInterfaceStores(client),
      now: () => NOW,
      newId: (prefix) =>
        `${prefix}_plan_${String(++sequence).padStart(4, "0")}`,
    });
    await seedAuthorizedLaunchers(service, 101, "pg-plan");
    await base.exec(
      `analyze takosumi_interfaces;
       analyze takosumi_interface_bindings;`,
    );

    const page =
      await service.listAuthorizedUiSurfaceCandidatesForPrincipalPage(
        { workspaceId: "workspace_page", phase: "Resolved" },
        "principal_page",
        "ui.open",
        { limit: 100 },
      );
    expect(page.items).toHaveLength(100);
    expect(page.nextCursor).toBeString();
    if (!client.authorizedRead) {
      throw new Error("Postgres authorized Interface read was not observed");
    }
    const explained = await base.query<{ readonly "QUERY PLAN": string }>(
      `explain (costs off) ${client.authorizedRead.sql}`,
      client.authorizedRead.parameters,
    );
    const plan = explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan).toContain(
      "takosumi_interface_bindings_authorized_current_idx",
    );
    expect(plan).toContain("takosumi_interfaces_pkey");
    expect(plan).not.toMatch(/\bSeq Scan on takosumi_interfaces\b/u);
    expect(plan).not.toMatch(/\bSeq Scan on takosumi_interface_bindings\b/u);

    // The planner may prefer the smaller exact-Principal Binding set and sort
    // only those rows. Disable sequential scans only for this plan proof so the
    // test also verifies that the outer index has the exact cursor-order prefix
    // available when that path is cheaper for a different data distribution.
    await base.exec("set enable_seqscan = off");
    const cursorExplained = await base.query<{
      readonly "QUERY PLAN": string;
    }>(
      `explain (costs off)
       select i.record_json from takosumi_interfaces i
       where i.workspace_id = $1 and i.phase = 'Resolved'
       order by i.created_at asc, i.id asc
       limit $2`,
      ["workspace_page", 101],
    );
    await base.exec("reset enable_seqscan");
    const cursorPlan = cursorExplained.rows
      .map((row) => row["QUERY PLAN"])
      .join("\n");
    expect(cursorPlan).toContain("takosumi_interfaces_authorized_page_idx");
    expect(cursorPlan).not.toContain("Sort Key: i.created_at, i.id");
  } finally {
    await base.close();
  }
});

test("Postgres v104 adds Interface authorization indexes without rewriting rows", async () => {
  const client = await PGliteSqlClient.createThroughMigrationVersion(103);
  try {
    await client.query(
      `insert into takosumi_interfaces (
         id, workspace_id, owner_kind, owner_id, name, interface_type, phase,
         generation, resolved_revision, record_json, created_at, updated_at
       ) values (
         'if_v104', 'workspace_v104', 'Capsule', 'capsule_v104', 'launcher',
         'interface.ui.surface', 'Resolved', 1, 1, '{"preserved":true}'::jsonb,
         $1, $1
       )`,
      [NOW],
    );
    const before = await client.query<{ readonly indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = current_schema()
         and tablename in ('takosumi_interfaces', 'takosumi_interface_bindings')
         and indexname like '%authorized_%'`,
    );
    expect(before.rows).toEqual([]);

    const migration = postgresStorageMigrationStatements.find(
      (entry) => entry.version === 104,
    );
    if (!migration) throw new Error("Postgres v104 migration is missing");
    for (const statement of splitSqlStatements(migration.sql)) {
      await client.exec(statement);
    }

    expect(
      await client.query(
        `select record_json from takosumi_interfaces where id = 'if_v104'`,
      ),
    ).toMatchObject({
      rows: [{ record_json: { preserved: true } }],
    });
    const after = await client.query<{ readonly indexname: string }>(
      `select indexname from pg_indexes
       where schemaname = current_schema()
         and indexname in (
           'takosumi_interfaces_authorized_page_idx',
           'takosumi_interface_bindings_authorized_current_idx'
         )
       order by indexname`,
    );
    expect(after.rows.map((row) => row.indexname)).toEqual([
      "takosumi_interface_bindings_authorized_current_idx",
      "takosumi_interfaces_authorized_page_idx",
    ]);
  } finally {
    await client.close();
  }
});
