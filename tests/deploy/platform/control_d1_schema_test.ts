import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "bun:test";

import {
  applyControlD1Schema,
  buildControlD1SchemaPlan,
  digestControlD1MaintenanceFence,
  fenceControlD1Schema,
  releaseControlD1Candidate,
  reconcileControlD1CandidateRelease,
  SqliteControlD1Database,
  verifyControlD1Candidate,
  verifyControlD1TransferSource,
  verifyControlD1Schema,
} from "../../../deploy/platform/control_d1_schema.ts";
import { runControlD1SchemaCli } from "../../../deploy/platform/control_d1_schema_cli.ts";
import type { D1Database } from "../../../worker/src/bindings.ts";
import {
  CloudflareControlD1RestDatabase,
  ControlD1RestError,
} from "../../../deploy/platform/control_d1_schema_rest.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
import {
  acquireControlD1MaintenanceFence,
  assertControlD1MaintenanceInactive,
  ControlD1MaintenanceError,
  readControlD1MaintenanceState,
  releaseControlD1MaintenanceFence,
} from "../../../worker/src/d1_schema_maintenance.ts";

const SOURCE_COMMIT = "a".repeat(40);
const PREDECESSOR_SOURCE_COMMIT = "b".repeat(40);
const PREDECESSOR_MANIFEST_DIGEST = `sha256:${"c".repeat(64)}`;
const NOW = "2026-07-16T00:00:00.000Z";

interface AppliedControlD1CatalogFixture {
  readonly schemaVersion: 1;
  readonly migrations: readonly {
    readonly version: number;
    readonly name: string;
    readonly checksum: string;
  }[];
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type RestQuery = {
  readonly sql: string;
  readonly params?: readonly (string | number | null)[];
};

function createD1RestAndImportFetch(
  backing: SqliteControlD1Database,
  options: { readonly pendingPolls?: number } = {},
) {
  const uploads = new Map<string, string>();
  const filenames = new Map<string, string>();
  const bookmarks = new Map<string, { etag: string; remaining: number }>();
  const completed = new Set<string>();
  const stats = {
    importIngests: 0,
    polls: 0,
    queryTriggerRejections: 0,
    uploadedSql: [] as string[],
    uploadAuthorizationHeaders: [] as (string | null)[],
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "d1-import-upload.example.test") {
      const etag = url.pathname.slice(1);
      const sql = String(init?.body ?? "");
      uploads.set(etag, sql);
      stats.uploadedSql.push(sql);
      stats.uploadAuthorizationHeaders.push(
        new Headers(init?.headers).get("authorization"),
      );
      return new Response(null, {
        status: 200,
        headers: { etag: `"${etag}"` },
      });
    }

    const body = JSON.parse(String(init?.body ?? "{}")) as
      | RestQuery
      | { readonly batch: readonly RestQuery[] }
      | {
          readonly action: "init" | "ingest";
          readonly etag: string;
          readonly filename?: string;
        }
      | { readonly action: "poll"; readonly current_bookmark: string };
    if (url.pathname.endsWith("/import")) {
      if (!("action" in body)) throw new Error("missing import action");
      if (body.action === "init") {
        if (completed.has(body.etag)) {
          return Response.json({
            success: true,
            result: { status: "complete", success: true },
          });
        }
        const filename = `control-${body.etag}.sql`;
        filenames.set(filename, body.etag);
        return Response.json({
          success: true,
          result: {
            filename,
            upload_url: `https://d1-import-upload.example.test/${body.etag}`,
          },
        });
      }
      if (body.action === "ingest") {
        const etag = filenames.get(body.filename ?? "");
        const sql = etag ? uploads.get(etag) : undefined;
        if (!etag || etag !== body.etag || !sql) {
          return Response.json({
            success: true,
            result: { status: "error", error: "missing upload" },
          });
        }
        try {
          backing.exec(`begin immediate;\n${sql}\ncommit;`);
        } catch (error) {
          return Response.json({
            success: true,
            result: { status: "error", error: String(error) },
          });
        }
        stats.importIngests += 1;
        const remaining = options.pendingPolls ?? 0;
        if (remaining === 0) {
          completed.add(etag);
          return Response.json({
            success: true,
            result: { status: "complete", success: true },
          });
        }
        const bookmark = `bookmark-${etag}`;
        bookmarks.set(bookmark, { etag, remaining });
        return Response.json({
          success: true,
          result: { at_bookmark: bookmark },
        });
      }
      if (body.action === "poll") {
        stats.polls += 1;
        const current = bookmarks.get(body.current_bookmark);
        if (!current) {
          return Response.json({
            success: true,
            result: { status: "error", error: "unknown bookmark" },
          });
        }
        if (current.remaining > 1) {
          bookmarks.set(body.current_bookmark, {
            ...current,
            remaining: current.remaining - 1,
          });
          return Response.json({ success: true, result: {} });
        }
        completed.add(current.etag);
        bookmarks.delete(body.current_bookmark);
        return Response.json({
          success: true,
          result: { status: "complete", success: true },
        });
      }
    }

    if (!url.pathname.endsWith("/query") || "action" in body) {
      throw new Error(`unexpected test request: ${url}`);
    }
    const queries = "batch" in body ? body.batch : [body];
    if (
      queries.some((query) =>
        query.sql.trimStart().toUpperCase().startsWith("CREATE TRIGGER"),
      )
    ) {
      stats.queryTriggerRejections += 1;
      return Response.json(
        {
          success: false,
          errors: [{ code: 7500, message: "incomplete input: SQLITE_ERROR" }],
        },
        { status: 400 },
      );
    }
    try {
      const result =
        "batch" in body
          ? await backing.batch(
              body.batch.map((query) =>
                backing.prepare(query.sql).bind(...(query.params ?? [])),
              ),
            )
          : [
              await backing
                .prepare(body.sql)
                .bind(...(body.params ?? []))
                .all(),
            ];
      return Response.json({ success: true, result });
    } catch {
      return Response.json(
        { success: false, errors: [{ code: 7500, message: "SQLITE_ERROR" }] },
        { status: 400 },
      );
    }
  };
  return { fetch, stats };
}

async function seedLiveV24ConvergenceRows(
  database: D1Database,
  environment: "staging" | "production",
): Promise<void> {
  await database
    .prepare(
      `insert into workspaces
         (id, handle, record_json, created_at, updated_at)
       values ('ws_live_v24', 'live-v24', ?, ?, ?)`,
    )
    .bind(JSON.stringify({ fixture: environment }), NOW, NOW)
    .run();
  await database
    .prepare(
      `insert into capsule_compatibility_reports (
         id, source_id, installation_id, source_snapshot_id, level,
         findings_json, providers_json, resources_json, data_sources_json,
         provisioners_json, normalized_object_key, normalized_digest,
         root_module_variables_json, root_module_outputs_json, created_at
       ) values (
         'compat_live_v24', 'source_live_v24', 'capsule_live_v24',
         'snapshot_live_v24', 'ready', '[]', '[]', '[]', '[]', '[]',
         'retired/object', 'sha256:retired', '["input"]', '["output"]', ?
       )`,
    )
    .bind(NOW)
    .run();
  await database
    .prepare(
      `insert into resolution_locks (
         resource_id, selected_implementation, target, locked, reason_json,
         portability, native_resources_json, locked_at, updated_at
       ) values (
         'resource_live_v24', 'adapter.test', 'target_live_v24', 1, '{}',
         'portable', '[]', ?, ?
       )`,
    )
    .bind(NOW, NOW)
    .run();
  await database
    .prepare(
      `insert into resource_shapes (
         id, space_id, project, environment, kind, name, managed_by,
         spec_json, phase, generation, observed_generation, outputs_json,
         conditions_json, labels_json, created_at, updated_at
       ) values (
         'resource_live_v24', 'ws_live_v24', 'default', 'default',
         'Service', 'live-v24', 'takosumi', '{}', 'Ready', 2, 2, '{}',
         '[]', '{}', ?, ?
       )`,
    )
    .bind(NOW, NOW)
    .run();
  await database
    .prepare(
      `insert into runs (
         id, run_group_id, space_id, source_id, installation_id, environment,
         type, status, lease_token, heartbeat_at, run_json, created_at
       ) values (
         'run_live_v24', 'group_live_v24', 'ws_live_v24', 'source_live_v24',
         'capsule_live_v24', 'default', 'apply', 'succeeded', 'lease-v24', 42,
         '{}', ?
       )`,
    )
    .bind(NOW)
    .run();
  await database
    .prepare(
      `insert into state_versions (
         id, space_id, installation_id, environment, generation, object_key,
         digest, created_by_run_id, created_at
       ) values (
         'state_live_v24', 'ws_live_v24', 'capsule_live_v24', 'default', 7,
         'state/live-v24', 'sha256:state-live-v24', 'run_live_v24', ?
       )`,
    )
    .bind(NOW)
    .run();
}

async function readLiveV24ConvergenceRows(database: D1Database) {
  return {
    workspace: await database
      .prepare(
        `select id, handle, record_json, created_at, updated_at
         from workspaces where id = 'ws_live_v24'`,
      )
      .first(),
    compatibility: await database
      .prepare(
        `select id, source_id, installation_id, source_snapshot_id, level,
                findings_json, providers_json, resources_json,
                data_sources_json, provisioners_json,
                root_module_variables_json, root_module_outputs_json,
                created_at
         from capsule_compatibility_reports where id = 'compat_live_v24'`,
      )
      .first(),
    resolutionLock: await database
      .prepare(
        `select resource_id, selected_implementation, target, locked,
                reason_json, portability, native_resources_json, locked_at,
                updated_at
         from resolution_locks where resource_id = 'resource_live_v24'`,
      )
      .first(),
    resource: await database
      .prepare(
        `select id, space_id, project, environment, kind, name, managed_by,
                spec_json, phase, generation, observed_generation,
                outputs_json, conditions_json, labels_json, created_at,
                updated_at
         from resource_shapes where id = 'resource_live_v24'`,
      )
      .first(),
    run: await database
      .prepare(
        `select id, run_group_id, space_id, source_id, installation_id,
                environment, type, status, lease_token, heartbeat_at,
                run_json, created_at
         from runs where id = 'run_live_v24'`,
      )
      .first(),
    stateVersion: await database
      .prepare(
        `select id, space_id, installation_id, environment, generation,
                object_key, digest, created_by_run_id, created_at
         from state_versions where id = 'state_live_v24'`,
      )
      .first(),
  };
}

async function legacyApplicationSchemaSnapshot(database: D1Database) {
  const objects = await database
    .prepare(
      `select type, name, tbl_name, sql
       from sqlite_master
       where type in ('table', 'index', 'view')
         and name not like 'sqlite_%'
         and name != '_takosumi_control_schema_maintenance'
       order by type, name`,
    )
    .all();
  const ledger = await database
    .prepare(
      `select version, name, checksum, applied_at
       from schema_migrations order by version`,
    )
    .all();
  return { objects: objects.results ?? [], ledger: ledger.results ?? [] };
}

async function seedAppendedV48InterfaceLayout(
  database: D1Database,
): Promise<void> {
  await database.prepare(`drop table interfaces`).run();
  await database
    .prepare(
      `create table interfaces (
        id text primary key,
        workspace_id text not null,
        owner_kind text not null,
        owner_id text not null,
        name text not null,
        interface_type text not null,
        phase text not null,
        generation integer not null,
        resolved_revision integer not null,
        record_json text not null,
        created_at text not null,
        updated_at text not null,
        oauth_resource_uri text,
        form_ref_key text,
        form_schema_digest text,
        descriptor_name text,
        descriptor_version text
      )`,
    )
    .run();
  await database
    .prepare(
      `create unique index interfaces_active_name_unique
       on interfaces (workspace_id, owner_kind, owner_id, name)
       where phase <> 'Retired'`,
    )
    .run();
  await database
    .prepare(
      `create index interfaces_workspace_type_phase_idx
       on interfaces (workspace_id, interface_type, phase)`,
    )
    .run();
  await database
    .prepare(
      `create unique index interfaces_oauth_resource_claim_unique
       on interfaces (workspace_id, owner_kind, owner_id, oauth_resource_uri)
       where oauth_resource_uri is not null`,
    )
    .run();
  await database
    .prepare(
      `create index interfaces_form_descriptor_idx
       on interfaces (
         workspace_id, form_ref_key, form_schema_digest,
         descriptor_name, descriptor_version
       ) where form_ref_key is not null`,
    )
    .run();
  await database
    .prepare(
      `insert into interfaces (
         id, workspace_id, owner_kind, owner_id, name, interface_type, phase,
         generation, resolved_revision, record_json, created_at, updated_at,
         oauth_resource_uri, form_ref_key, form_schema_digest,
         descriptor_name, descriptor_version
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "iface_v48",
      "ws_v48",
      "resource",
      "resource_v48",
      "document",
      "document.display",
      "Ready",
      3,
      2,
      JSON.stringify({ id: "iface_v48", generation: 3 }),
      NOW,
      NOW,
      "https://resource.example.test",
      "forms.takoform.com/v1alpha1|Document|1.0.0",
      `sha256:${"d".repeat(64)}`,
      "display",
      "1",
    )
    .run();
  await database
    .prepare(
      `insert into interface_bindings (
         id, workspace_id, interface_id, subject_kind, subject_id, phase,
         generation, record_json, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "ifbind_v48",
      "ws_v48",
      "iface_v48",
      "service_account",
      "sa_v48",
      "Active",
      4,
      JSON.stringify({ id: "ifbind_v48", interfaceId: "iface_v48" }),
      NOW,
      NOW,
    )
    .run();
  await database
    .prepare(`delete from schema_migrations where version = 49`)
    .run();
}

async function readV48InterfaceRows(database: D1Database) {
  return {
    interface: await database
      .prepare(
        `select id, workspace_id, owner_kind, owner_id, name, interface_type,
                phase, generation, resolved_revision, oauth_resource_uri,
                form_ref_key, form_schema_digest, descriptor_name,
                descriptor_version, record_json, created_at, updated_at
         from interfaces where id = 'iface_v48'`,
      )
      .first(),
    binding: await database
      .prepare(
        `select id, workspace_id, interface_id, subject_kind, subject_id,
                phase, generation, record_json, created_at, updated_at
         from interface_bindings where id = 'ifbind_v48'`,
      )
      .first(),
  };
}

async function seedImmediatePredecessorV54(
  database: D1Database,
): Promise<void> {
  await database
    .prepare(
      `insert into capsule_compatibility_reports (
         id, source_id, installation_id, source_snapshot_id, level,
         findings_json, providers_json, resources_json, data_sources_json,
         provisioners_json, root_module_variables_json,
         root_module_outputs_json, created_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "caprep_v51",
      "source_v51",
      "capsule_v51",
      "snapshot_v51",
      "ready",
      "[]",
      "[]",
      "[]",
      "[]",
      "[]",
      "[]",
      "[]",
      NOW,
    )
    .run();
  await database
    .prepare(
      `insert into interfaces (
         id, workspace_id, owner_kind, owner_id, name, interface_type, phase,
         generation, resolved_revision, oauth_resource_uri, form_ref_key,
         form_schema_digest, descriptor_name, descriptor_version, record_json,
         created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "iface_v48",
      "ws_v48",
      "resource",
      "resource_v48",
      "document",
      "document.display",
      "Ready",
      3,
      2,
      "https://resource.example.test",
      "forms.takoform.com/v1alpha1|Document|1.0.0",
      `sha256:${"d".repeat(64)}`,
      "display",
      "1",
      JSON.stringify({ id: "iface_v48", generation: 3 }),
      NOW,
      NOW,
    )
    .run();
  await database
    .prepare(
      `insert into interface_bindings (
         id, workspace_id, interface_id, subject_kind, subject_id, phase,
         generation, record_json, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      "ifbind_v48",
      "ws_v48",
      "iface_v48",
      "service_account",
      "sa_v48",
      "Active",
      4,
      JSON.stringify({ id: "ifbind_v48", interfaceId: "iface_v48" }),
      NOW,
      NOW,
    )
    .run();
  await database
    .prepare(`alter table resource_shapes drop column revision`)
    .run();
  await database
    .prepare(`delete from schema_migrations where version = 55`)
    .run();
}

async function seedImmediatePredecessorV55(
  database: D1Database,
): Promise<void> {
  await database
    .prepare(`alter table resource_shapes drop column owner_json`)
    .run();
  await database
    .prepare(`delete from schema_migrations where version = 56`)
    .run();
}

async function seedImmediatePredecessorV63(
  database: D1Database,
): Promise<void> {
  await database.prepare(`delete from schema_migrations where version = 64`).run();
}

async function readPredecessorInterfaceRows(database: D1Database) {
  return {
    interface: await database
      .prepare(
        `select id, workspace_id, owner_kind, owner_id, name, interface_type,
                phase, generation, resolved_revision, oauth_resource_uri,
                form_ref_key, form_schema_digest, descriptor_name,
                descriptor_version, record_json, created_at, updated_at
         from interfaces where id = 'iface_v48'`,
      )
      .first(),
    binding: await database
      .prepare(
        `select id, workspace_id, interface_id, subject_kind, subject_id,
                phase, generation, record_json, created_at, updated_at
         from interface_bindings where id = 'ifbind_v48'`,
      )
      .first(),
    compatibilityReport: await database
      .prepare(
        `select id, source_id, installation_id, source_snapshot_id, level,
                findings_json, providers_json, resources_json,
                data_sources_json, provisioners_json,
                root_module_variables_json, root_module_outputs_json,
                created_at
         from capsule_compatibility_reports where id = 'caprep_v51'`,
      )
      .first(),
  };
}

async function downgradeMaintenanceTableToV48(
  database: D1Database,
): Promise<void> {
  for (const column of [
    "predecessor_fence_id",
    "predecessor_source_commit",
    "predecessor_manifest_digest",
  ]) {
    await database
      .prepare(
        `alter table _takosumi_control_schema_maintenance
         drop column ${column}`,
      )
      .run();
  }
}

test("control D1 plan captures the full OSS schema and migration ledger", async () => {
  const plan = await buildControlD1SchemaPlan();
  expect(plan.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(plan.schemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(plan.ledgerDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(plan.migrations.at(-1)?.version).toBe(64);
  expect(plan.migrations).toHaveLength(61);
  expect(plan.migrations.at(-1)?.name).toBe(
    "d1_capsule_execution_authority_epoch",
  );
  expect(plan.tables.some((table) => table.name === "target_pools")).toBe(true);
  expect(
    plan.tables.some((table) => table.name === "resource_identity_fences"),
  ).toBe(true);
  expect(
    plan.tables.some((table) => table.name === "takosumi_target_pools"),
  ).toBe(false);
  const usageEvents = plan.tables.find(
    (table) => table.name === "usage_events",
  );
  expect(usageEvents?.sql).toContain("CHECK");
  expect(
    usageEvents?.indexes.some(
      (index) => index.name.startsWith("sqlite_autoindex_") && index.unique,
    ),
  ).toBe(true);
  expect(usageEvents?.columns.every((column) => column.hidden === 0)).toBe(
    true,
  );
  const interfaces = plan.tables.find((table) => table.name === "interfaces");
  expect(interfaces?.columns.map((column) => column.name)).toEqual(
    expect.arrayContaining([
      "form_ref_key",
      "form_schema_digest",
      "descriptor_name",
      "descriptor_version",
    ]),
  );
  expect(
    interfaces?.indexes.some(
      (index) => index.name === "interfaces_form_descriptor_idx",
    ),
  ).toBe(true);
  expect(
    interfaces?.indexes.some(
      (index) => index.name === "interfaces_authorized_page_idx",
    ),
  ).toBe(true);
  const interfaceBindings = plan.tables.find(
    (table) => table.name === "interface_bindings",
  );
  expect(
    interfaceBindings?.indexes.some(
      (index) => index.name === "interface_bindings_authorized_current_idx",
    ),
  ).toBe(true);
  const workspaces = plan.tables.find((table) => table.name === "workspaces");
  expect(workspaces?.columns.map((column) => column.name)).toEqual(
    expect.arrayContaining([
      "owner_user_id",
      "workspace_type",
      "personal_bootstrap_owner_id",
    ]),
  );
  expect(
    workspaces?.indexes.some(
      (index) => index.name === "workspaces_owner_type_created_idx",
    ),
  ).toBe(true);
  expect(
    workspaces?.indexes.some(
      (index) =>
        index.name === "workspaces_personal_bootstrap_owner_unique" &&
        index.unique,
    ),
  ).toBe(true);
});

test("control D1 migrations preserve checksums accepted by existing v42 databases", async () => {
  const fixture = (await Bun.file(
    resolve(
      import.meta.dir,
      "fixtures/valid-applied-control-d1-catalog-v42.json",
    ),
  ).json()) as AppliedControlD1CatalogFixture;
  const plan = await buildControlD1SchemaPlan();

  expect(fixture.schemaVersion).toBe(1);
  expect(
    plan.migrations
      .slice(0, fixture.migrations.length)
      .map(({ version, name, checksum }) => ({ version, name, checksum })),
  ).toEqual(fixture.migrations);
  expect(fixture.migrations.at(-1)?.version).toBe(42);
});

test("control D1 verify is read-only and accepts host extension tables", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    await database
      .prepare(
        `create table cloud_extension_state (
          id text primary key,
          record_json text not null
        )`,
      )
      .run();
    await database
      .prepare(
        `create view cloud_extension_view as
         select id from cloud_extension_state`,
      )
      .run();
    const verification = await verifyControlD1Schema(database, plan);
    expect(verification.status).toBe("ready");
    expect(verification.issues).toEqual([]);
    expect(verification.latestMigrationVersion).toBe(64);
  } finally {
    database.close();
  }
});

test("control D1 verification inventories triggers and views attached to OSS tables", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    await database
      .prepare(
        `create trigger unexpected_workspace_trigger
         after insert on workspaces
         begin
           select 1;
         end`,
      )
      .run();
    await database
      .prepare(
        `create view unexpected_workspace_view as
         select id from workspaces`,
      )
      .run();
    const verification = await verifyControlD1Schema(database, plan);
    expect(verification.status).toBe("mismatch");
    expect(verification.issues).toContain("schema_attached_object_mismatch");
  } finally {
    database.close();
  }
});

test("control D1 apply converges a fresh database and records every version", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    const applied = await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "test",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
    });
    expect(applied.verification.status).toBe("ready");
    expect(applied.beforeMigrationVersions).toEqual([]);
    expect(applied.appliedMigrationVersions).toEqual(
      plan.migrations.map((migration) => migration.version),
    );
  } finally {
    database.close();
  }
});

test("control D1 v49 atomically preserves populated appended-order Interfaces through predecessor fence recovery", async () => {
  const plan = await buildControlD1SchemaPlan({
    throughMigrationVersion: 49,
  });
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database, {
      throughMigrationVersion: 49,
    });
    await seedAppendedV48InterfaceLayout(database);
    const before = await readV48InterfaceRows(database);
    const beforeVerification = await verifyControlD1Schema(database, plan);
    expect(beforeVerification.issues).toContain(
      "schema_table_mismatch:interfaces",
    );
    expect(beforeVerification.issues).toContain("migration_ledger_mismatch");

    const predecessorFence = await acquireControlD1MaintenanceFence(
      database,
      {
        sourceCommit: PREDECESSOR_SOURCE_COMMIT,
        manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
        environment: "staging",
        databaseRole: "in_place",
        releasePolicy: "in_place",
        databaseId: "database_staging",
      },
      NOW,
    );
    // Live v48 predates durable predecessor lineage. Recovery must add these
    // nullable columns before the first state read while the old fence and all
    // guards remain active.
    await downgradeMaintenanceTableToV48(database);
    await database
      .prepare(`drop trigger "_takosumi_schema_fence_interfaces_insert"`)
      .run();

    let supersessionBatchCount = 0;
    let firstUpgradeBatchBlockedWrite = false;
    const migrationDatabase: D1Database = {
      prepare: (query) => database.prepare(query),
      batch: async <T>(statements) => {
        const results = await database.batch<T>(statements);
        supersessionBatchCount += 1;
        if (supersessionBatchCount === 1) {
          try {
            await database
              .prepare(
                `insert into interfaces (
                   id, workspace_id, owner_kind, owner_id, name,
                   interface_type, phase, generation, resolved_revision,
                   record_json, created_at, updated_at
                 ) values (
                   'iface_upgrade_gap', 'ws_v48', 'resource', 'resource_gap',
                   'gap', 'document.display', 'Ready', 1, 0, '{}', ?, ?
                 )`,
              )
              .bind(NOW, NOW)
              .run();
          } catch (error) {
            firstUpgradeBatchBlockedWrite = String(error).includes(
              "takosumi control schema maintenance",
            );
          }
        }
        return results;
      },
    };
    let blockedDuringTransition = 0;
    const applyWithPredecessor = (retainMaintenanceFence: boolean) =>
      applyControlD1Schema(migrationDatabase, plan, {
        sourceCommit: SOURCE_COMMIT,
        environment: "staging",
        activatedAt: "2026-07-16T00:01:00.000Z",
        releasedAt: () => "2026-07-16T00:02:00.000Z",
        maintenanceDrainMilliseconds: 0,
        waitForRequestDrain: async () => {
          await expect(
            database
              .prepare(
                `insert into interfaces (
                   id, workspace_id, owner_kind, owner_id, name,
                   interface_type, phase, generation, resolved_revision,
                   record_json, created_at, updated_at
                 ) values (
                   'iface_blocked', 'ws_v48', 'resource', 'resource_blocked',
                   'blocked', 'document.display', 'Ready', 1, 0, '{}', ?, ?
                 )`,
              )
              .bind(NOW, NOW)
              .run(),
          ).rejects.toThrow("takosumi control schema maintenance");
          blockedDuringTransition += 1;
        },
        retainMaintenanceFence,
        databaseRole: "in_place",
        releasePolicy: "in_place",
        databaseId: "database_staging",
        activePredecessorFence: {
          sourceCommit: PREDECESSOR_SOURCE_COMMIT,
          manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
        },
      });

    const retained = await applyWithPredecessor(true);
    expect(retained.appliedMigrationVersions).toEqual([49]);
    expect(retained.verification.status).toBe("ready");
    expect(retained.maintenanceStatus).toBe("retained");
    expect(retained.predecessorMaintenanceFence).toEqual(predecessorFence);
    expect(firstUpgradeBatchBlockedWrite).toBe(true);
    expect(await readV48InterfaceRows(database)).toEqual(before);
    const interfaceGuards = await database
      .prepare(
        `select name from sqlite_master
         where type = 'trigger'
           and tbl_name = 'interfaces'
           and name like '_takosumi_schema_fence_interfaces_%'
         order by name`,
      )
      .all<{ readonly name: string }>();
    expect((interfaceGuards.results ?? []).map((row) => row.name)).toEqual([
      "_takosumi_schema_fence_interfaces_delete",
      "_takosumi_schema_fence_interfaces_insert",
      "_takosumi_schema_fence_interfaces_update",
    ]);

    const resumed = await applyWithPredecessor(false);
    expect(resumed.appliedMigrationVersions).toEqual([]);
    expect(resumed.maintenanceStatus).toBe("released");
    expect(resumed.predecessorMaintenanceFence).toEqual(predecessorFence);
    expect(blockedDuringTransition).toBe(2);
    expect(await readV48InterfaceRows(database)).toEqual(before);
    expect(await verifyControlD1Schema(database, plan)).toMatchObject({
      status: "ready",
      latestMigrationVersion: 49,
      issues: [],
    });
    expect(await readControlD1MaintenanceState(database)).toEqual({
      status: "inactive",
    });
    expect(
      await database
        .prepare(
          `select name from sqlite_master
           where type = 'table' and name = 'interfaces__takosumi_v49'`,
        )
        .first(),
    ).toBeNull();
  } finally {
    database.close();
  }
});

for (const responseLossBatch of [1, 2, 3] as const) {
  test(`control D1 v49 predecessor recovery resumes after committed batch ${responseLossBatch} loses its response`, async () => {
    const plan = await buildControlD1SchemaPlan({
      throughMigrationVersion: 49,
    });
    const database = new SqliteControlD1Database();
    try {
      await ensureD1OpenTofuLedgerSchema(database, {
        throughMigrationVersion: 49,
      });
      await seedAppendedV48InterfaceLayout(database);
      const before = await readV48InterfaceRows(database);
      await acquireControlD1MaintenanceFence(
        database,
        {
          sourceCommit: PREDECESSOR_SOURCE_COMMIT,
          manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
          environment: "staging",
          databaseRole: "in_place",
          releasePolicy: "in_place",
          databaseId: "database_staging",
        },
        NOW,
      );
      await downgradeMaintenanceTableToV48(database);

      let batchCount = 0;
      let responseLost = false;
      const responseLossDatabase: D1Database = {
        prepare: (query) => database.prepare(query),
        batch: async <T>(statements) => {
          const results = await database.batch<T>(statements);
          batchCount += 1;
          if (!responseLost && batchCount === responseLossBatch) {
            responseLost = true;
            throw new Error(`simulated committed batch ${responseLossBatch}`);
          }
          return results;
        },
      };
      const apply = () =>
        applyControlD1Schema(responseLossDatabase, plan, {
          sourceCommit: SOURCE_COMMIT,
          environment: "staging",
          activatedAt: "2026-07-16T00:01:00.000Z",
          releasedAt: () => "2026-07-16T00:02:00.000Z",
          maintenanceDrainMilliseconds: 0,
          waitForRequestDrain: async () => {},
          retainMaintenanceFence: true,
          databaseRole: "in_place",
          releasePolicy: "in_place",
          databaseId: "database_staging",
          activePredecessorFence: {
            sourceCommit: PREDECESSOR_SOURCE_COMMIT,
            manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
          },
        });

      await expect(apply()).rejects.toBeInstanceOf(Error);
      expect(responseLost).toBe(true);
      expect(await readControlD1MaintenanceState(database)).toMatchObject({
        status: "active",
      });
      expect(await readV48InterfaceRows(database)).toEqual(before);
      await expect(
        database
          .prepare(
            `insert into interfaces (
               id, workspace_id, owner_kind, owner_id, name, interface_type,
               phase, generation, resolved_revision, record_json,
               created_at, updated_at
             ) values (
               'response-loss-blocked', 'ws_v48', 'resource', 'resource_loss',
               'blocked', 'document.display', 'Ready', 1, 0, '{}', ?, ?
             )`,
          )
          .bind(NOW, NOW)
          .run(),
      ).rejects.toThrow("takosumi control schema maintenance");

      const resumed = await apply();
      expect(resumed.verification).toMatchObject({
        status: "ready",
        latestMigrationVersion: 49,
        issues: [],
      });
      expect(resumed.appliedMigrationVersions).toEqual(
        responseLossBatch === 3 ? [] : [49],
      );
      expect(resumed.maintenanceStatus).toBe("retained");
      expect(await readV48InterfaceRows(database)).toEqual(before);
      const state = await readControlD1MaintenanceState(database);
      expect(state).toMatchObject({
        status: "active",
        fence: {
          sourceCommit: SOURCE_COMMIT,
          manifestDigest: plan.manifestDigest,
          predecessor: {
            sourceCommit: PREDECESSOR_SOURCE_COMMIT,
            manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
          },
        },
      });
      await expect(
        database
          .prepare(
            `insert into interfaces (
               id, workspace_id, owner_kind, owner_id, name, interface_type,
               phase, generation, resolved_revision, record_json,
               created_at, updated_at
             ) values (
               'retry-blocked', 'ws_v48', 'resource', 'resource_retry',
               'blocked', 'document.display', 'Ready', 1, 0, '{}', ?, ?
             )`,
          )
          .bind(NOW, NOW)
          .run(),
      ).rejects.toThrow("takosumi control schema maintenance");
      expect(
        await database
          .prepare(
            `select name from sqlite_master
             where type = 'table' and name = 'interfaces__takosumi_v49'`,
          )
          .first(),
      ).toBeNull();
    } finally {
      database.close();
    }
  });
}

test("control D1 v55 preserves predecessor rows through the fenced Resource revision migration", async () => {
  const plan = await buildControlD1SchemaPlan({
    throughMigrationVersion: 55,
  });
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database, {
      throughMigrationVersion: 55,
    });
    await seedImmediatePredecessorV54(database);
    const before = await readPredecessorInterfaceRows(database);
    const beforeVerification = await verifyControlD1Schema(database, plan);
    expect(beforeVerification.issues).toContain(
      "schema_table_mismatch:resource_shapes",
    );
    expect(beforeVerification.issues).toContain("migration_ledger_mismatch");

    const predecessorFence = await acquireControlD1MaintenanceFence(
      database,
      {
        sourceCommit: PREDECESSOR_SOURCE_COMMIT,
        manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
        environment: "staging",
        databaseRole: "in_place",
        releasePolicy: "in_place",
        databaseId: "database_staging",
      },
      NOW,
    );
    // The predecessor fixture predates durable predecessor lineage. Recovery must add these
    // nullable columns before the first state read while the old fence and all
    // guards remain active.
    await downgradeMaintenanceTableToV48(database);
    await database
      .prepare(`drop trigger "_takosumi_schema_fence_interfaces_insert"`)
      .run();

    let supersessionBatchCount = 0;
    let firstUpgradeBatchBlockedWrite = false;
    const migrationDatabase: D1Database = {
      prepare: (query) => database.prepare(query),
      batch: async <T>(statements) => {
        const results = await database.batch<T>(statements);
        supersessionBatchCount += 1;
        if (supersessionBatchCount === 1) {
          try {
            await database
              .prepare(
                `insert into interfaces (
                   id, workspace_id, owner_kind, owner_id, name,
                   interface_type, phase, generation, resolved_revision,
                   record_json, created_at, updated_at
                 ) values (
                   'iface_upgrade_gap', 'ws_v48', 'resource', 'resource_gap',
                   'gap', 'document.display', 'Ready', 1, 0, '{}', ?, ?
                 )`,
              )
              .bind(NOW, NOW)
              .run();
          } catch (error) {
            firstUpgradeBatchBlockedWrite = String(error).includes(
              "takosumi control schema maintenance",
            );
          }
        }
        return results;
      },
    };
    let blockedDuringTransition = 0;
    const applyWithPredecessor = (retainMaintenanceFence: boolean) =>
      applyControlD1Schema(migrationDatabase, plan, {
        sourceCommit: SOURCE_COMMIT,
        environment: "staging",
        activatedAt: "2026-07-16T00:01:00.000Z",
        releasedAt: () => "2026-07-16T00:02:00.000Z",
        maintenanceDrainMilliseconds: 0,
        waitForRequestDrain: async () => {
          await expect(
            database
              .prepare(
                `insert into interfaces (
                   id, workspace_id, owner_kind, owner_id, name,
                   interface_type, phase, generation, resolved_revision,
                   record_json, created_at, updated_at
                 ) values (
                   'iface_blocked', 'ws_v48', 'resource', 'resource_blocked',
                   'blocked', 'document.display', 'Ready', 1, 0, '{}', ?, ?
                 )`,
              )
              .bind(NOW, NOW)
              .run(),
          ).rejects.toThrow("takosumi control schema maintenance");
          blockedDuringTransition += 1;
        },
        retainMaintenanceFence,
        databaseRole: "in_place",
        releasePolicy: "in_place",
        databaseId: "database_staging",
        activePredecessorFence: {
          sourceCommit: PREDECESSOR_SOURCE_COMMIT,
          manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
        },
      });

    const retained = await applyWithPredecessor(true);
    expect(retained.appliedMigrationVersions).toEqual([55]);
    expect(retained.verification.status).toBe("ready");
    expect(retained.maintenanceStatus).toBe("retained");
    expect(retained.predecessorMaintenanceFence).toEqual(predecessorFence);
    expect(firstUpgradeBatchBlockedWrite).toBe(true);
    expect(await readPredecessorInterfaceRows(database)).toEqual(before);
    const interfaceGuards = await database
      .prepare(
        `select name from sqlite_master
         where type = 'trigger'
           and tbl_name = 'interfaces'
           and name like '_takosumi_schema_fence_interfaces_%'
         order by name`,
      )
      .all<{ readonly name: string }>();
    expect((interfaceGuards.results ?? []).map((row) => row.name)).toEqual([
      "_takosumi_schema_fence_interfaces_delete",
      "_takosumi_schema_fence_interfaces_insert",
      "_takosumi_schema_fence_interfaces_update",
    ]);

    const resumed = await applyWithPredecessor(false);
    expect(resumed.appliedMigrationVersions).toEqual([]);
    expect(resumed.maintenanceStatus).toBe("released");
    expect(resumed.predecessorMaintenanceFence).toEqual(predecessorFence);
    expect(blockedDuringTransition).toBe(2);
    expect(await readPredecessorInterfaceRows(database)).toEqual(before);
    expect(await verifyControlD1Schema(database, plan)).toMatchObject({
      status: "ready",
      latestMigrationVersion: 55,
      issues: [],
    });
    expect(await readControlD1MaintenanceState(database)).toEqual({
      status: "inactive",
    });
    expect(
      await database
        .prepare(
          `select name from sqlite_master
           where type = 'table' and name = 'interfaces__takosumi_v49'`,
        )
        .first(),
    ).toBeNull();
  } finally {
    database.close();
  }
});

for (const responseLossBatch of [1, 2, 3] as const) {
  test(`control D1 v55 predecessor recovery resumes after committed batch ${responseLossBatch} loses its response`, async () => {
    const plan = await buildControlD1SchemaPlan({
      throughMigrationVersion: 55,
    });
    const database = new SqliteControlD1Database();
    try {
      await ensureD1OpenTofuLedgerSchema(database, {
        throughMigrationVersion: 55,
      });
      await seedImmediatePredecessorV54(database);
      const before = await readPredecessorInterfaceRows(database);
      await acquireControlD1MaintenanceFence(
        database,
        {
          sourceCommit: PREDECESSOR_SOURCE_COMMIT,
          manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
          environment: "staging",
          databaseRole: "in_place",
          releasePolicy: "in_place",
          databaseId: "database_staging",
        },
        NOW,
      );
      await downgradeMaintenanceTableToV48(database);

      let batchCount = 0;
      let responseLost = false;
      const responseLossDatabase: D1Database = {
        prepare: (query) => database.prepare(query),
        batch: async <T>(statements) => {
          const results = await database.batch<T>(statements);
          batchCount += 1;
          if (!responseLost && batchCount === responseLossBatch) {
            responseLost = true;
            throw new Error(`simulated committed batch ${responseLossBatch}`);
          }
          return results;
        },
      };
      const apply = () =>
        applyControlD1Schema(responseLossDatabase, plan, {
          sourceCommit: SOURCE_COMMIT,
          environment: "staging",
          activatedAt: "2026-07-16T00:01:00.000Z",
          releasedAt: () => "2026-07-16T00:02:00.000Z",
          maintenanceDrainMilliseconds: 0,
          waitForRequestDrain: async () => {},
          retainMaintenanceFence: true,
          databaseRole: "in_place",
          releasePolicy: "in_place",
          databaseId: "database_staging",
          activePredecessorFence: {
            sourceCommit: PREDECESSOR_SOURCE_COMMIT,
            manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
          },
        });

      await expect(apply()).rejects.toBeInstanceOf(Error);
      expect(responseLost).toBe(true);
      expect(await readControlD1MaintenanceState(database)).toMatchObject({
        status: "active",
      });
      expect(await readPredecessorInterfaceRows(database)).toEqual(before);
      await expect(
        database
          .prepare(
            `insert into interfaces (
               id, workspace_id, owner_kind, owner_id, name, interface_type,
               phase, generation, resolved_revision, record_json,
               created_at, updated_at
             ) values (
               'response-loss-blocked', 'ws_v48', 'resource', 'resource_loss',
               'blocked', 'document.display', 'Ready', 1, 0, '{}', ?, ?
             )`,
          )
          .bind(NOW, NOW)
          .run(),
      ).rejects.toThrow("takosumi control schema maintenance");

      const resumed = await apply();
      expect(resumed.verification).toMatchObject({
        status: "ready",
        latestMigrationVersion: 55,
        issues: [],
      });
      expect(resumed.appliedMigrationVersions).toEqual(
        responseLossBatch === 3 ? [] : [55],
      );
      expect(resumed.maintenanceStatus).toBe("retained");
      expect(await readPredecessorInterfaceRows(database)).toEqual(before);
      const state = await readControlD1MaintenanceState(database);
      expect(state).toMatchObject({
        status: "active",
        fence: {
          sourceCommit: SOURCE_COMMIT,
          manifestDigest: plan.manifestDigest,
          predecessor: {
            sourceCommit: PREDECESSOR_SOURCE_COMMIT,
            manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
          },
        },
      });
      await expect(
        database
          .prepare(
            `insert into interfaces (
               id, workspace_id, owner_kind, owner_id, name, interface_type,
               phase, generation, resolved_revision, record_json,
               created_at, updated_at
             ) values (
               'retry-blocked', 'ws_v48', 'resource', 'resource_retry',
               'blocked', 'document.display', 'Ready', 1, 0, '{}', ?, ?
             )`,
          )
          .bind(NOW, NOW)
          .run(),
      ).rejects.toThrow("takosumi control schema maintenance");
      expect(
        await database
          .prepare(
            `select name from sqlite_master
             where type = 'table' and name = 'interfaces__takosumi_v49'`,
          )
          .first(),
      ).toBeNull();
    } finally {
      database.close();
    }
  });
}

test("control D1 predecessor fence recovery rejects identity and non-immediate ledger drift without opening writes", async () => {
  const plan = await buildControlD1SchemaPlan({
    throughMigrationVersion: 55,
  });
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database, {
      throughMigrationVersion: 55,
    });
    await seedImmediatePredecessorV54(database);
    const predecessorFence = await acquireControlD1MaintenanceFence(
      database,
      {
        sourceCommit: PREDECESSOR_SOURCE_COMMIT,
        manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
        environment: "staging",
        databaseRole: "in_place",
        releasePolicy: "in_place",
        databaseId: "database_staging",
      },
      NOW,
    );
    const baseOptions = {
      sourceCommit: SOURCE_COMMIT,
      environment: "staging" as const,
      activatedAt: "2026-07-16T00:01:00.000Z",
      releasedAt: () => "2026-07-16T00:02:00.000Z",
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      databaseRole: "in_place" as const,
      releasePolicy: "in_place" as const,
      databaseId: "database_staging",
    };

    await expect(
      applyControlD1Schema(database, plan, {
        ...baseOptions,
        activePredecessorFence: {
          sourceCommit: PREDECESSOR_SOURCE_COMMIT,
          manifestDigest: `sha256:${"0".repeat(64)}`,
        },
      }),
    ).rejects.toThrow("maintenance_fence_predecessor_mismatch");
    await expect(
      applyControlD1Schema(database, plan, {
        ...baseOptions,
        databaseId: "database_other",
        activePredecessorFence: {
          sourceCommit: PREDECESSOR_SOURCE_COMMIT,
          manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
        },
      }),
    ).rejects.toThrow("maintenance_fence_predecessor_mismatch");

    await database
      .prepare(`delete from schema_migrations where version = 54`)
      .run();
    await expect(
      applyControlD1Schema(database, plan, {
        ...baseOptions,
        activePredecessorFence: {
          sourceCommit: PREDECESSOR_SOURCE_COMMIT,
          manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
        },
      }),
    ).rejects.toThrow("maintenance_fence_predecessor_not_immediate");
    expect(await readControlD1MaintenanceState(database)).toMatchObject({
      status: "active",
      fence: predecessorFence,
    });
    await expect(
      database
        .prepare(
          `insert into workspaces
             (id, handle, record_json, created_at, updated_at)
           values ('still-blocked', 'still-blocked', '{}', ?, ?)`,
        )
        .bind(NOW, NOW)
        .run(),
    ).rejects.toThrow("takosumi control schema maintenance");
  } finally {
    database.close();
  }
});

test("control D1 predecessor recovery rejects a full ledger behind the old fence", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    const predecessorFence = await acquireControlD1MaintenanceFence(
      database,
      {
        sourceCommit: PREDECESSOR_SOURCE_COMMIT,
        manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
        environment: "staging",
        databaseRole: "in_place",
        releasePolicy: "in_place",
        databaseId: "database_staging",
      },
      NOW,
    );

    await expect(
      applyControlD1Schema(database, plan, {
        sourceCommit: SOURCE_COMMIT,
        environment: "staging",
        activatedAt: NOW,
        releasedAt: () => NOW,
        maintenanceDrainMilliseconds: 0,
        waitForRequestDrain: async () => {},
        databaseRole: "in_place",
        releasePolicy: "in_place",
        databaseId: "database_staging",
        activePredecessorFence: {
          sourceCommit: PREDECESSOR_SOURCE_COMMIT,
          manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
        },
      }),
    ).rejects.toThrow("maintenance_fence_predecessor_not_immediate");
    expect(await readControlD1MaintenanceState(database)).toMatchObject({
      status: "active",
      fence: predecessorFence,
    });
    await expect(
      database
        .prepare(
          `insert into workspaces
             (id, handle, record_json, created_at, updated_at)
           values ('full-ledger-blocked', 'full-ledger-blocked', '{}', ?, ?)`,
        )
        .bind(NOW, NOW)
        .run(),
    ).rejects.toThrow("takosumi control schema maintenance");
  } finally {
    database.close();
  }
});

test("control D1 fenced apply converges a populated v24 destructive schema", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    await database
      .prepare(`delete from schema_migrations where version >= 25`)
      .run();
    await database
      .prepare(
        `alter table install_configs
         add column install_type text not null default 'opentofu_module'`,
      )
      .run();
    await database
      .prepare(
        `alter table install_configs
         add column trust_level text not null default 'trusted'`,
      )
      .run();
    await database.prepare(`drop table capsules`).run();
    await database
      .prepare(
        `create table capsules (
          id text primary key,
          space_id text not null,
          project_id text,
          name text not null,
          slug text not null,
          source_id text,
          install_type text not null,
          install_config_id text not null,
          environment text not null,
          current_state_version_id text,
          current_state_generation integer not null default 0,
          current_output_snapshot_id text,
          status text not null,
          record_json text not null,
          created_at text not null,
          updated_at text not null
        )`,
      )
      .run();
    await database.prepare(`drop table usage_events`).run();
    await database
      .prepare(
        `create table usage_events (
          id text primary key,
          space_id text not null,
          installation_id text,
          run_id text,
          meter_id text,
          resource_family text,
          resource_id text,
          operation text,
          resource_metadata_json text,
          kind text not null,
          quantity real not null,
          usd_micros integer,
          source text not null,
          idempotency_key text not null,
          created_at text not null
        )`,
      )
      .run();
    await database
      .prepare(`create table billing_accounts (id text primary key)`)
      .run();
    await database
      .prepare(
        `insert into workspaces
           (id, handle, record_json, created_at, updated_at)
         values ('ws_v24', 'v24', ?, ?, ?)`,
      )
      .bind(JSON.stringify({ id: "ws_v24", ownerUserId: "acct_v24" }), NOW, NOW)
      .run();
    await database
      .prepare(
        `insert into projects
           (id, workspace_id, name, slug, record_json, created_at, updated_at)
         values ('prj_default_ws_v24', 'ws_v24', 'Default', 'default', '{}', ?, ?)`,
      )
      .bind(NOW, NOW)
      .run();
    await database
      .prepare(
        `insert into install_configs
           (id, space_id, record_json, created_at, updated_at,
            install_type, trust_level)
         values ('cfg_v24', 'ws_v24', ?, ?, ?, 'opentofu_module', 'trusted')`,
      )
      .bind(
        JSON.stringify({
          id: "cfg_v24",
          installType: "opentofu_module",
          trustLevel: "trusted",
        }),
        NOW,
        NOW,
      )
      .run();
    await database
      .prepare(
        `insert into capsules (
           id, space_id, project_id, name, slug, source_id, install_type,
           install_config_id, environment, current_state_generation, status,
           record_json, created_at, updated_at
         ) values (
           'cap_v24', 'ws_v24', null, 'Demo', 'demo', null,
           'opentofu_module', 'cfg_v24', 'default', 0, 'active', ?, ?, ?
         )`,
      )
      .bind(
        JSON.stringify({ id: "cap_v24", installType: "opentofu_module" }),
        NOW,
        NOW,
      )
      .run();
    await database
      .prepare(
        `insert into usage_events (
           id, space_id, installation_id, kind, quantity, usd_micros, source,
           idempotency_key, created_at
         ) values (
           'usage_v24', 'ws_v24', 'cap_v24', 'request', 1, 999, 'legacy',
           'usage-v24', ?
         )`,
      )
      .bind(NOW)
      .run();
    await database
      .prepare(`insert into billing_accounts (id) values ('retired')`)
      .run();

    const applied = await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "test",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
    });

    expect(applied.verification.status).toBe("ready");
    expect(applied.appliedMigrationVersions).toEqual(
      plan.migrations
        .filter((migration) => migration.version >= 25)
        .map((migration) => migration.version),
    );
    expect(
      await database
        .prepare(`select project_id from capsules where id = 'cap_v24'`)
        .first(),
    ).toEqual({ project_id: "prj_default_ws_v24" });
    expect(
      await database
        .prepare(
          `select usd_micros, rating_status
           from usage_events where id = 'usage_v24'`,
        )
        .first(),
    ).toEqual({ usd_micros: 0, rating_status: "unrated" });
    expect(
      await database
        .prepare(
          `select name from sqlite_master
           where type = 'table' and name = 'billing_accounts'`,
        )
        .first(),
    ).toBeNull();
  } finally {
    database.close();
  }
});

for (const fixture of [
  {
    environment: "staging",
    file: "staging-schema.sql",
    sha256: "1fa2455c3d880f99f727be07404190439a5588e492116df8c4dff6fd64e5c86e",
  },
  {
    environment: "production",
    file: "production-schema.sql",
    sha256: "76b930c0fde893d49ef9b9bf2738f9882103d5de0da18f134593e52f2f349848",
  },
] as const) {
  test(`control D1 candidate converges the ${fixture.environment} live v24 schema export`, async () => {
    const plan = await buildControlD1SchemaPlan();
    const database = new SqliteControlD1Database();
    const sql = await Bun.file(
      resolve(
        import.meta.dir,
        "../../fixtures/control-d1-live-v24",
        fixture.file,
      ),
    ).text();
    try {
      expect(await sha256Hex(sql)).toBe(fixture.sha256);
      database.exec(sql);
      for (const migration of plan.migrations.filter(
        (entry) => entry.version <= 24,
      )) {
        await database
          .prepare(
            `insert into schema_migrations (version, name, checksum, applied_at)
             values (?, ?, ?, ?)`,
          )
          .bind(migration.version, migration.name, migration.checksum, NOW)
          .run();
      }

      await seedLiveV24ConvergenceRows(database, fixture.environment);
      const before = await readLiveV24ConvergenceRows(database);
      const applied = await applyControlD1Schema(database, plan, {
        sourceCommit: SOURCE_COMMIT,
        environment: "test",
        activatedAt: NOW,
        releasedAt: () => NOW,
        maintenanceDrainMilliseconds: 0,
        waitForRequestDrain: async () => {},
        retainMaintenanceFence: true,
      });

      expect(applied.maintenanceStatus).toBe("retained");
      expect(applied.verification.status).toBe("ready");
      expect(applied.appliedMigrationVersions).toEqual(
        plan.migrations
          .filter((entry) => entry.version >= 25)
          .map((entry) => entry.version),
      );
      for (const table of ["resource_shapes", "resolution_locks"] as const) {
        expect(
          await database
            .prepare(
              `select form_ref_json, package_digest from ${table} limit 1`,
            )
            .first(),
        ).toEqual({ form_ref_json: null, package_digest: null });
      }
      expect(await readLiveV24ConvergenceRows(database)).toEqual(before);
      await expect(
        database
          .prepare(
            `insert into workspaces
               (id, handle, record_json, created_at, updated_at)
             values ('blocked', 'blocked', '{}', ?, ?)`,
          )
          .bind(NOW, NOW)
          .run(),
      ).rejects.toThrow("takosumi control schema maintenance");
    } finally {
      database.close();
    }
  });
}

test("control D1 apply recovers a committed fence release after a lost response", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    let batchCalls = 0;
    const lostReleaseResponse: D1Database = {
      prepare(query) {
        return database.prepare(query);
      },
      async batch(statements) {
        batchCalls += 1;
        const result = await database.batch(statements);
        if (batchCalls === 2) throw new Error("lost release response");
        return result;
      },
    };

    const applied = await applyControlD1Schema(lostReleaseResponse, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "test",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
    });
    expect(batchCalls).toBe(2);
    expect(applied.verification.status).toBe("ready");
    expect((await verifyControlD1Schema(database, plan)).status).toBe("ready");
  } finally {
    database.close();
  }
});

test("control D1 verification detects CHECK drift with identical columns", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    await database
      .prepare(`alter table usage_events rename to usage_events__with_check`)
      .run();
    await database
      .prepare(
        `create table usage_events (
          id text primary key,
          workspace_id text not null,
          capsule_id text,
          run_id text,
          meter_id text,
          resource_family text,
          resource_id text,
          operation text,
          resource_metadata_json text,
          kind text not null,
          quantity real not null,
          usd_micros integer not null,
          rating_status text not null,
          source text not null,
          idempotency_key text not null,
          created_at text not null
        )`,
      )
      .run();
    await database.prepare(`drop table usage_events__with_check`).run();
    await database
      .prepare(
        `create index usage_events_workspace_idx
         on usage_events (workspace_id)`,
      )
      .run();
    await database
      .prepare(`create index usage_events_run_idx on usage_events (run_id)`)
      .run();
    await database
      .prepare(
        `create unique index usage_events_idempotency_key_unique
         on usage_events (idempotency_key)`,
      )
      .run();

    const verification = await verifyControlD1Schema(database, plan);
    expect(verification.status).toBe("mismatch");
    expect(verification.issues).toContain("schema_table_mismatch:usage_events");
  } finally {
    database.close();
  }
});

test("control D1 maintenance fence blocks direct writes and readiness", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    await acquireControlD1MaintenanceFence(
      database,
      {
        sourceCommit: SOURCE_COMMIT,
        manifestDigest: plan.manifestDigest,
        environment: "test",
      },
      NOW,
    );
    await expect(assertControlD1MaintenanceInactive(database)).rejects.toThrow(
      "maintenance_fence_active",
    );
    await expect(
      database
        .prepare(
          `insert into workspaces
             (id, handle, record_json, created_at, updated_at)
           values ('blocked', 'blocked', '{}', ?, ?)`,
        )
        .bind(NOW, NOW)
        .run(),
    ).rejects.toThrow("takosumi control schema maintenance");
    const verification = await verifyControlD1Schema(database, plan);
    expect(verification.issues).toContain("maintenance_fence_active");
  } finally {
    database.close();
  }
});

test("control D1 maintenance guards user tables but never D1 internal _cf_KV", async () => {
  const database = new SqliteControlD1Database();
  try {
    await database
      .prepare(`create table "_cf_KV" (key text primary key, value text)`)
      .run();
    await database
      .prepare(`create table user_records (id text primary key, value text)`)
      .run();
    await acquireControlD1MaintenanceFence(
      database,
      {
        sourceCommit: SOURCE_COMMIT,
        manifestDigest: `sha256:${"b".repeat(64)}`,
        environment: "test",
      },
      NOW,
    );

    const triggers = await database
      .prepare(
        `select name, tbl_name from sqlite_master
         where type = 'trigger' and name like '_takosumi_schema_fence_%'
         order by name`,
      )
      .all<{ readonly name: string; readonly tbl_name: string }>();
    expect(
      (triggers.results ?? []).filter((row) => row.tbl_name === "_cf_KV"),
    ).toEqual([]);
    expect(
      (triggers.results ?? [])
        .filter((row) => row.tbl_name === "user_records")
        .map((row) => row.name),
    ).toEqual([
      "_takosumi_schema_fence_user_records_delete",
      "_takosumi_schema_fence_user_records_insert",
      "_takosumi_schema_fence_user_records_update",
    ]);

    await expect(
      database
        .prepare(`insert into "_cf_KV" (key, value) values ('one', 'allowed')`)
        .run(),
    ).resolves.toMatchObject({ success: true });
    await expect(
      database
        .prepare(
          `insert into user_records (id, value) values ('one', 'blocked')`,
        )
        .run(),
    ).rejects.toThrow("takosumi control schema maintenance");
  } finally {
    database.close();
  }
});

test("control D1 maintenance state fails closed on missing, contradictory, or malformed state", async () => {
  for (const corrupt of [
    `delete from _takosumi_control_schema_maintenance where singleton = 1`,
    `update _takosumi_control_schema_maintenance
     set active = 0, migration_bypass = 1, released_at = '${NOW}'
     where singleton = 1`,
    `update _takosumi_control_schema_maintenance
     set source_commit = 'malformed'
     where singleton = 1`,
  ]) {
    const database = new SqliteControlD1Database();
    try {
      await ensureD1OpenTofuLedgerSchema(database);
      await acquireControlD1MaintenanceFence(
        database,
        {
          sourceCommit: SOURCE_COMMIT,
          manifestDigest: `sha256:${"b".repeat(64)}`,
          environment: "test",
        },
        NOW,
      );
      await database.prepare(corrupt).run();
      await expect(
        assertControlD1MaintenanceInactive(database),
      ).rejects.toThrow("maintenance_fence_invalid");
      await expect(
        database
          .prepare(
            `insert into workspaces
               (id, handle, record_json, created_at, updated_at)
             values ('corrupt', 'corrupt', '{}', ?, ?)`,
          )
          .bind(NOW, NOW)
          .run(),
      ).rejects.toThrow("takosumi control schema maintenance");
    } finally {
      database.close();
    }
  }
});

test("legacy fence leaves the production v24 application schema and ledger immutable", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  const sql = await Bun.file(
    resolve(
      import.meta.dir,
      "../../fixtures/control-d1-live-v24/production-schema.sql",
    ),
  ).text();
  try {
    database.exec(sql);
    for (const migration of plan.migrations.filter(
      (entry) => entry.version <= 24,
    )) {
      await database
        .prepare(
          `insert into schema_migrations (version, name, checksum, applied_at)
           values (?, ?, ?, ?)`,
        )
        .bind(migration.version, migration.name, migration.checksum, NOW)
        .run();
    }
    const before = await legacyApplicationSchemaSnapshot(database);
    const fenced = await fenceControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "production",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
    });

    expect(fenced.maintenanceFence.environment).toBe("production");
    expect(fenced.maintenanceFence.databaseRole).toBe("legacy");
    expect(fenced.maintenanceFence.releasePolicy).toBe("never");
    expect(await legacyApplicationSchemaSnapshot(database)).toEqual(before);
    expect(
      await database
        .prepare(`select max(version) as version from schema_migrations`)
        .first(),
    ).toEqual({ version: 24 });
    await expect(
      database
        .prepare(
          `insert into workspaces
             (id, handle, record_json, created_at, updated_at)
           values ('legacy-blocked', 'legacy-blocked', '{}', ?, ?)`,
        )
        .bind(NOW, NOW)
        .run(),
    ).rejects.toThrow("takosumi control schema maintenance");
    await expect(
      releaseControlD1MaintenanceFence(database, fenced.maintenanceFence, NOW),
    ).rejects.toThrow("maintenance_fence_not_releasable");
    await expect(
      applyControlD1Schema(database, plan, {
        sourceCommit: SOURCE_COMMIT,
        environment: "production",
        activatedAt: NOW,
        releasedAt: () => NOW,
        maintenanceDrainMilliseconds: 0,
        waitForRequestDrain: async () => {},
      }),
    ).rejects.toThrow("maintenance_fence_occupied");
    expect(await readControlD1MaintenanceState(database)).toMatchObject({
      status: "active",
      fence: { databaseRole: "legacy", releasePolicy: "never" },
    });
  } finally {
    database.close();
  }
});

test("control D1 verification fails closed on ledger and retired-table drift", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    await database
      .prepare(
        `update schema_migrations
         set checksum = ?
         where version = 43`,
      )
      .bind(`sha256:${"0".repeat(64)}`)
      .run();
    await database
      .prepare(`create table workspace_output_sync (workspace_id text)`)
      .run();
    const verification = await verifyControlD1Schema(database, plan);
    expect(verification.status).toBe("mismatch");
    expect(verification.issues).toContain("migration_ledger_mismatch");
    expect(verification.issues).toContain(
      "retired_table_present:workspace_output_sync",
    );
  } finally {
    database.close();
  }
});

test("control D1 CLI plan and apply dry-run never create a remote target", async () => {
  for (const argv of [
    ["plan"],
    ["apply", "--environment", "production", "--dry-run"],
  ]) {
    let remoteCalls = 0;
    const output: string[] = [];
    const code = await runControlD1SchemaCli(
      argv,
      {},
      (value) => output.push(value),
      {
        sourceCommit: SOURCE_COMMIT,
        now: () => NOW,
        createRemoteDatabase: () => {
          remoteCalls += 1;
          throw new Error("remote must not be called");
        },
      },
    );
    expect(code).toBe(0);
    expect(remoteCalls).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      status: "planned",
      sourceCommit: SOURCE_COMMIT,
    });
  }
});

test("control D1 CLI verify reports a ready remote ledger", async () => {
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    const output: string[] = [];
    const code = await runControlD1SchemaCli(
      ["verify", "--environment", "staging"],
      {},
      (value) => output.push(value),
      {
        sourceCommit: SOURCE_COMMIT,
        now: () => NOW,
        createRemoteDatabase: () => ({
          database,
          configurationDigest: `sha256:${"1".repeat(64)}`,
        }),
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      mode: "verify",
      environment: "staging",
      status: "ready",
      verification: { latestMigrationVersion: 64 },
    });
  } finally {
    database.close();
  }
});

test("control D1 candidate verification and release bind the exact retained fence", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  const candidateDatabaseId = "control_candidate_staging";
  const sourceExportSha256 = `sha256:${"d".repeat(64)}`;
  const releaseReadinessDigest = `sha256:${"e".repeat(64)}`;
  try {
    const applied = await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "staging",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
      databaseRole: "candidate",
      releasePolicy: "cutover",
      databaseId: candidateDatabaseId,
      sourceExportSha256,
    });
    const fenceDigest = await digestControlD1MaintenanceFence(
      applied.maintenanceFence,
    );
    const verified = await verifyControlD1Candidate(database, plan, {
      environment: "staging",
      sourceCommit: SOURCE_COMMIT,
      manifestDigest: plan.manifestDigest,
      candidateDatabaseId,
      sourceExportSha256,
      expectedFenceDigest: fenceDigest,
    });
    expect(verified.status).toBe("ready");
    expect(verified.maintenanceStatus).toBe("retained");
    expect(verified.integrity.status).toBe("ready");
    expect(verified.guardInventory?.guardedTableCount).toBeGreaterThan(0);
    expect(verified.guardInventory?.guardTriggerCount).toBe(
      (verified.guardInventory?.guardedTableCount ?? 0) * 3,
    );
    const released = await releaseControlD1Candidate(database, plan, {
      environment: "staging",
      sourceCommit: SOURCE_COMMIT,
      manifestDigest: plan.manifestDigest,
      candidateDatabaseId,
      sourceExportSha256,
      expectedFenceDigest: fenceDigest,
      confirmReleaseReadinessDigest: releaseReadinessDigest,
      releasedAt: "2026-07-16T00:01:00.000Z",
    });
    expect(released.status).toBe("released");
    expect(released.releaseReadinessDigest).toBe(releaseReadinessDigest);
    expect(await readControlD1MaintenanceState(database)).toEqual({
      status: "inactive",
    });
  } finally {
    database.close();
  }
});

test("control D1 candidate release rejects wrong fence digest before mutation", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  const candidateDatabaseId = "control_candidate_staging";
  const sourceExportSha256 = `sha256:${"f".repeat(64)}`;
  try {
    const applied = await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "staging",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
      databaseRole: "candidate",
      releasePolicy: "cutover",
      databaseId: candidateDatabaseId,
      sourceExportSha256,
    });
    await expect(
      releaseControlD1Candidate(database, plan, {
        environment: "staging",
        sourceCommit: SOURCE_COMMIT,
        manifestDigest: plan.manifestDigest,
        candidateDatabaseId,
        sourceExportSha256,
        expectedFenceDigest: `sha256:${"0".repeat(64)}`,
        confirmReleaseReadinessDigest: `sha256:${"1".repeat(64)}`,
        releasedAt: "2026-07-16T00:01:00.000Z",
      }),
    ).rejects.toThrow("candidate_verification_failed");
    const state = await readControlD1MaintenanceState(database);
    expect(state).toMatchObject({
      status: "active",
      fence: { fenceId: applied.maintenanceFence.fenceId },
    });
  } finally {
    database.close();
  }
});

test("control D1 transfer source verification binds the permanent legacy fence and logical evidence", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  const sourceDatabaseId = "control_source_staging";
  const sourceExportSha256 = `sha256:${"2".repeat(64)}`;
  try {
    await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "staging",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
      databaseRole: "legacy",
      releasePolicy: "never",
      databaseId: sourceDatabaseId,
    });
    const verified = await verifyControlD1TransferSource(database, plan, {
      environment: "staging",
      sourceCommit: SOURCE_COMMIT,
      manifestDigest: plan.manifestDigest,
      sourceDatabaseId,
      sourceExportSha256,
      sourceExportBookmark: "bookmark-source-staging",
    });
    expect(verified.status).toBe("ready");
    expect(verified.sourceFence).toMatchObject({
      databaseRole: "legacy",
      releasePolicy: "never",
      databaseId: sourceDatabaseId,
      sourceExportSha256: null,
      predecessor: null,
    });
    expect(verified.guardInventory?.guardTriggerCount).toBe(
      (verified.guardInventory?.guardedTableCount ?? 0) * 3,
    );
    expect(verified.integrity.status).toBe("ready");
    expect(verified.logical.kind).toBe("takosumi.sqlite-logical-content@v1");
    expect(verified.logical.tables.length).toBeGreaterThan(6);
    expect(verified.protectedContentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(verified.captureAuthorityDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(verified.sourceExport.lineage.sourceFenceDigest).toBe(
      verified.sourceFenceDigest,
    );
    expect(await readControlD1MaintenanceState(database)).toMatchObject({
      status: "active",
      fence: { databaseRole: "legacy", releasePolicy: "never" },
    });
  } finally {
    database.close();
  }
});

test("control D1 CLI transfer-source-verify emits digest-bound source transcript", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  const sourceDatabaseId = "control_source_staging";
  const sourceExportSha256 = `sha256:${"4".repeat(64)}`;
  try {
    await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "staging",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
      databaseRole: "legacy",
      releasePolicy: "never",
      databaseId: sourceDatabaseId,
    });
    const output: string[] = [];
    const code = await runControlD1SchemaCli(
      [
        "transfer-source-verify",
        "--environment",
        "staging",
        "--confirm-manifest",
        plan.manifestDigest,
        "--confirm-database-id",
        sourceDatabaseId,
        "--confirm-source-export-sha256",
        sourceExportSha256,
        "--confirm-source-export-bookmark",
        "bookmark-source-staging",
      ],
      {},
      (value) => output.push(value),
      {
        sourceCommit: SOURCE_COMMIT,
        now: () => NOW,
        inspectSourceCheckout: async () => ({ head: SOURCE_COMMIT, clean: true }),
        createRemoteDatabase: () => ({
          database,
          configurationDigest: `sha256:${"5".repeat(64)}`,
          databaseId: sourceDatabaseId,
        }),
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      kind: "takosumi.control-d1-transfer-source-verify@v1",
      mode: "transfer-source-verify",
      status: "ready",
      captureAuthorityDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      protectedContentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      evidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
  } finally {
    database.close();
  }
});

test("control D1 authoritative source checks use reviewed nested Git", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  const sourceDatabaseId = "control_source_nested_git_staging";
  const sourceExportSha256 = `sha256:${"6".repeat(64)}`;
  const captureRoot = await mkdtemp(
    join(tmpdir(), "takosumi-control-d1-nested-git-"),
  );
  const fakeBin = join(captureRoot, "bin");
  const gitWrapper = join(fakeBin, "git");
  const previousPath = Bun.env.PATH;
  const previousTmpdir = Bun.env.TMPDIR;
  const checkout = resolve(import.meta.dir, "../../..");
  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(
      gitWrapper,
      [
        "#!/bin/sh",
        "set -eu",
        'case "$*" in',
        `  *"rev-parse HEAD"*) target="$TMPDIR/control-d1-git-rev-parse"; printf '%s\\n' "${SOURCE_COMMIT}";;`,
        '  *"status --porcelain --untracked-files=all"*) target="$TMPDIR/control-d1-git-status";;',
        '  *) echo "unexpected git invocation" >&2; exit 2;;',
        "esac",
        "{",
        '  printf "argv=%s\\n" "$*"',
        '  printf "GIT_CONFIG_NOSYSTEM=%s\\n" "${GIT_CONFIG_NOSYSTEM-}"',
        '  printf "GIT_CONFIG_GLOBAL=%s\\n" "${GIT_CONFIG_GLOBAL-}"',
        '  printf "GIT_TERMINAL_PROMPT=%s\\n" "${GIT_TERMINAL_PROMPT-}"',
        '  printf "LC_ALL=%s\\n" "${LC_ALL-}"',
        '  printf "LANG=%s\\n" "${LANG-}"',
        '  printf "PATH=%s\\n" "${PATH-}"',
        '  printf "HOME=%s\\n" "${HOME-}"',
        '  printf "TMPDIR=%s\\n" "${TMPDIR-}"',
        '} > "$target"',
        "",
      ].join("\n"),
    );
    await chmod(gitWrapper, 0o755);
    Bun.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    Bun.env.TMPDIR = captureRoot;

    await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "staging",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
      databaseRole: "legacy",
      releasePolicy: "never",
      databaseId: sourceDatabaseId,
    });
    const output: string[] = [];
    const code = await runControlD1SchemaCli(
      [
        "transfer-source-verify",
        "--environment",
        "staging",
        "--confirm-manifest",
        plan.manifestDigest,
        "--confirm-database-id",
        sourceDatabaseId,
        "--confirm-source-export-sha256",
        sourceExportSha256,
        "--confirm-source-export-bookmark",
        "bookmark-source-nested-git-staging",
      ],
      {},
      (value) => output.push(value),
      {
        sourceCommit: SOURCE_COMMIT,
        now: () => NOW,
        createRemoteDatabase: () => ({
          database,
          configurationDigest: `sha256:${"7".repeat(64)}`,
          databaseId: sourceDatabaseId,
        }),
      },
    );

    expect(code).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      mode: "transfer-source-verify",
      status: "ready",
    });
    const expectedConfigArgs =
      "-c core.hooksPath=/dev/null -c core.fsmonitor=false " +
      "-c core.attributesFile=/dev/null -c commit.gpgSign=false " +
      "-c tag.gpgSign=false";
    for (const [name, command] of [
      ["rev-parse", "rev-parse HEAD"],
      ["status", "status --porcelain --untracked-files=all"],
    ] as const) {
      const capture = await readFile(
        join(captureRoot, `control-d1-git-${name}`),
        "utf8",
      );
      expect(capture).toContain(
        `argv=${expectedConfigArgs} -C ${checkout} ${command}`,
      );
      expect(capture).toContain("GIT_CONFIG_NOSYSTEM=1");
      expect(capture).toContain("GIT_CONFIG_GLOBAL=/dev/null");
      expect(capture).toContain("GIT_TERMINAL_PROMPT=0");
      expect(capture).toContain("LC_ALL=C");
      expect(capture).toContain("LANG=C");
    }
  } finally {
    if (previousPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = previousPath;
    if (previousTmpdir === undefined) delete Bun.env.TMPDIR;
    else Bun.env.TMPDIR = previousTmpdir;
    database.close();
    await rm(captureRoot, { recursive: true, force: true });
  }
});

test("control D1 transfer source verification rejects source mismatch and tampered guard without mutation", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  const sourceDatabaseId = "control_source_staging";
  try {
    await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "staging",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
      databaseRole: "legacy",
      releasePolicy: "never",
      databaseId: sourceDatabaseId,
    });
    const wrongSource = await verifyControlD1TransferSource(database, plan, {
      environment: "staging",
      sourceCommit: SOURCE_COMMIT,
      manifestDigest: plan.manifestDigest,
      sourceDatabaseId: "wrong-source",
      sourceExportSha256: `sha256:${"3".repeat(64)}`,
      sourceExportBookmark: "bookmark-source-staging",
    });
    expect(wrongSource.status).toBe("mismatch");
    expect(wrongSource.issues).toContain("source_fence_database_id_mismatch");
    const guard = wrongSource.guardInventory?.triggers[0];
    expect(guard).toBeString();
    database.exec(`drop trigger "${guard}"`);
    const subset = await verifyControlD1TransferSource(database, plan, {
      environment: "staging",
      sourceCommit: SOURCE_COMMIT,
      manifestDigest: plan.manifestDigest,
      sourceDatabaseId,
      sourceExportSha256: `sha256:${"3".repeat(64)}`,
      sourceExportBookmark: "bookmark-source-staging",
    });
    expect(subset.status).toBe("mismatch");
    expect(subset.issues).toContain("maintenance_guard_inventory_mismatch");
    database.exec(
      `create trigger "${guard}" after insert on "workspaces" begin select 1; end`,
    );
    const tampered = await verifyControlD1TransferSource(database, plan, {
      environment: "staging",
      sourceCommit: SOURCE_COMMIT,
      manifestDigest: plan.manifestDigest,
      sourceDatabaseId,
      sourceExportSha256: `sha256:${"3".repeat(64)}`,
      sourceExportBookmark: "bookmark-source-staging",
    });
    expect(tampered.status).toBe("mismatch");
    expect(tampered.issues).toContain("maintenance_guard_inventory_mismatch");
    expect(await readControlD1MaintenanceState(database)).toMatchObject({
      status: "active",
      fence: { databaseId: sourceDatabaseId },
    });
  } finally {
    database.close();
  }
});

test("control D1 CLI exposes transferred candidate verify/release transcripts", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  const candidateDatabaseId = "control_candidate_staging";
  const sourceExportSha256 = `sha256:${"a".repeat(64)}`;
  const readinessDigest = `sha256:${"b".repeat(64)}`;
  try {
    const applied = await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "staging",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
      databaseRole: "candidate",
      releasePolicy: "cutover",
      databaseId: candidateDatabaseId,
      sourceExportSha256,
    });
    const fenceDigest = await digestControlD1MaintenanceFence(
      applied.maintenanceFence,
    );
    const dependencies = {
      sourceCommit: SOURCE_COMMIT,
      now: () => NOW,
      inspectSourceCheckout: async () => ({
        head: SOURCE_COMMIT,
        clean: true,
      }),
      createRemoteDatabase: () => ({
        database,
        configurationDigest: `sha256:${"c".repeat(64)}`,
        databaseId: candidateDatabaseId,
      }),
    };
    const verifyOutput: string[] = [];
    const verifyCode = await runControlD1SchemaCli(
      [
        "candidate-verify",
        "--environment",
        "staging",
        "--confirm-manifest",
        plan.manifestDigest,
        "--confirm-database-id",
        candidateDatabaseId,
        "--confirm-source-export-sha256",
        sourceExportSha256,
        "--confirm-fence-digest",
        fenceDigest,
      ],
      {},
      (value) => verifyOutput.push(value),
      dependencies,
    );
    expect(verifyCode).toBe(0);
    expect(JSON.parse(verifyOutput.at(-1) ?? "{}")).toMatchObject({
      mode: "candidate-verify",
      status: "ready",
      maintenanceFenceDigest: fenceDigest,
      maintenanceStatus: "retained",
    });
    const releaseOutput: string[] = [];
    const releaseCode = await runControlD1SchemaCli(
      [
        "candidate-release",
        "--environment",
        "staging",
        "--confirm-manifest",
        plan.manifestDigest,
        "--confirm-database-id",
        candidateDatabaseId,
        "--confirm-source-export-sha256",
        sourceExportSha256,
        "--confirm-fence-digest",
        fenceDigest,
        "--confirm-release-readiness-digest",
        readinessDigest,
        "--released-at",
        "2026-07-16T00:01:00.000Z",
      ],
      {},
      (value) => releaseOutput.push(value),
      dependencies,
    );
    expect(releaseCode).toBe(0);
    expect(JSON.parse(releaseOutput.at(-1) ?? "{}")).toMatchObject({
      mode: "candidate-release",
      status: "released",
      maintenanceFenceDigest: fenceDigest,
      releaseReadinessDigest: readinessDigest,
      maintenanceStatus: "released",
      lostAcknowledgementReconciled: false,
    });
  } finally {
    database.close();
  }
});

test("authoritative candidate reads require the exact clean source checkout", async () => {
  const plan = await buildControlD1SchemaPlan();
  const candidateDatabaseId = "control_candidate_source_check";
  const sourceExportSha256 = `sha256:${"a".repeat(64)}`;
  const fenceDigest = `sha256:${"b".repeat(64)}`;
  const readinessDigest = `sha256:${"c".repeat(64)}`;
  for (const command of ["candidate-verify", "candidate-release-status"] as const) {
    const output: string[] = [];
    const args = [
      command,
      "--environment",
      "staging",
      "--confirm-manifest",
      plan.manifestDigest,
      "--confirm-database-id",
      candidateDatabaseId,
      "--confirm-source-export-sha256",
      sourceExportSha256,
      "--confirm-fence-digest",
      fenceDigest,
      ...(command === "candidate-release-status"
        ? [
            "--confirm-release-readiness-digest",
            readinessDigest,
            "--released-at",
            "2026-07-16T00:01:00.000Z",
          ]
        : []),
    ];
    let remoteCreations = 0;
    const code = await runControlD1SchemaCli(
      args,
      {},
      (value) => output.push(value),
      {
        sourceCommit: SOURCE_COMMIT,
        inspectSourceCheckout: async () => ({
          head: SOURCE_COMMIT,
          clean: false,
        }),
        createRemoteDatabase: () => {
          remoteCreations += 1;
          throw new Error("dirty checkout must fail before remote access");
        },
      },
    );
    expect(code).toBe(1);
    expect(remoteCreations).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      mode: command,
      status: "failed",
      failureCode: "source_checkout_dirty",
    });
  }
});

test("control D1 candidate release does not adopt an indeterminate release response", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  const candidateDatabaseId = "control_candidate_staging";
  const sourceExportSha256 = `sha256:${"2".repeat(64)}`;
  try {
    const applied = await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "staging",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
      databaseRole: "candidate",
      releasePolicy: "cutover",
      databaseId: candidateDatabaseId,
      sourceExportSha256,
    });
    const fenceDigest = await digestControlD1MaintenanceFence(
      applied.maintenanceFence,
    );
    let batchCalls = 0;
    const lostResponse: D1Database = {
      prepare(query) {
        return database.prepare(query);
      },
      async batch(statements) {
        batchCalls += 1;
        const result = await database.batch(statements);
        if (batchCalls === 1) throw new Error("lost candidate release response");
        return result;
      },
    };
    await expect(
      releaseControlD1Candidate(lostResponse, plan, {
        environment: "staging",
        sourceCommit: SOURCE_COMMIT,
        manifestDigest: plan.manifestDigest,
        candidateDatabaseId,
        sourceExportSha256,
        expectedFenceDigest: fenceDigest,
        confirmReleaseReadinessDigest: `sha256:${"3".repeat(64)}`,
        releasedAt: "2026-07-16T00:01:00.000Z",
      }),
    ).rejects.toThrow("maintenance_fence_release_failed");
    expect(await readControlD1MaintenanceState(database)).toEqual({
      status: "inactive",
    });
    expect(batchCalls).toBe(1);
  } finally {
    database.close();
  }
});

test("control D1 candidate release reconciles one lost acknowledgement read-only", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  const candidateDatabaseId = "control_candidate_staging";
  const sourceExportSha256 = `sha256:${"8".repeat(64)}`;
  const releaseReadinessDigest = `sha256:${"9".repeat(64)}`;
  const releasedAt = "2026-07-16T00:01:00.000Z";
  try {
    const applied = await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "staging",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
      databaseRole: "candidate",
      releasePolicy: "cutover",
      databaseId: candidateDatabaseId,
      sourceExportSha256,
    });
    const fenceDigest = await digestControlD1MaintenanceFence(
      applied.maintenanceFence,
    );
    let batchCalls = 0;
    const lostResponse: D1Database = {
      prepare(query) {
        return database.prepare(query);
      },
      async batch(statements) {
        batchCalls += 1;
        const result = await database.batch(statements);
        if (batchCalls === 1) throw new Error("lost candidate release response");
        return result;
      },
    };
    await expect(
      releaseControlD1Candidate(lostResponse, plan, {
        environment: "staging",
        sourceCommit: SOURCE_COMMIT,
        manifestDigest: plan.manifestDigest,
        candidateDatabaseId,
        sourceExportSha256,
        expectedFenceDigest: fenceDigest,
        confirmReleaseReadinessDigest: releaseReadinessDigest,
        releasedAt,
      }),
    ).rejects.toThrow("maintenance_fence_release_failed");
    const reconciled = await releaseControlD1Candidate(database, plan, {
      environment: "staging",
      sourceCommit: SOURCE_COMMIT,
      manifestDigest: plan.manifestDigest,
      candidateDatabaseId,
      sourceExportSha256,
      expectedFenceDigest: fenceDigest,
      confirmReleaseReadinessDigest: releaseReadinessDigest,
      releasedAt,
    });
    expect(reconciled.lostAcknowledgementReconciled).toBe(true);
    expect(reconciled.releaseReadinessDigest).toBe(releaseReadinessDigest);
    expect(reconciled.guardInventory.guardTriggerCount).toBeGreaterThan(0);
    expect(batchCalls).toBe(1);
    await expect(
      releaseControlD1Candidate(database, plan, {
        environment: "staging",
        sourceCommit: SOURCE_COMMIT,
        manifestDigest: plan.manifestDigest,
        candidateDatabaseId,
        sourceExportSha256,
        expectedFenceDigest: fenceDigest,
        confirmReleaseReadinessDigest: `sha256:${"a".repeat(64)}`,
        releasedAt,
      }),
    ).rejects.toThrow("candidate_release_receipt_mismatch");
    await expect(
      releaseControlD1Candidate(database, plan, {
        environment: "staging",
        sourceCommit: SOURCE_COMMIT,
        manifestDigest: plan.manifestDigest,
        candidateDatabaseId,
        sourceExportSha256,
        expectedFenceDigest: fenceDigest,
        confirmReleaseReadinessDigest: releaseReadinessDigest,
        releasedAt: "2026-07-16T00:02:00.000Z",
      }),
    ).rejects.toThrow("candidate_release_receipt_mismatch");
    await expect(
      releaseControlD1Candidate(database, plan, {
        environment: "staging",
        sourceCommit: SOURCE_COMMIT,
        manifestDigest: plan.manifestDigest,
        candidateDatabaseId,
        sourceExportSha256,
        expectedFenceDigest: `sha256:${"b".repeat(64)}`,
        confirmReleaseReadinessDigest: releaseReadinessDigest,
        releasedAt,
      }),
    ).rejects.toThrow("candidate_release_receipt_mismatch");
  } finally {
    database.close();
  }
});

test("control D1 candidate-release-status is read-only and rejects an active fence", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  const candidateDatabaseId = "control_candidate_status";
  const sourceExportSha256 = `sha256:${"0".repeat(64)}`;
  try {
    await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "staging",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
      databaseRole: "candidate",
      releasePolicy: "cutover",
      databaseId: candidateDatabaseId,
      sourceExportSha256,
    });
    let batches = 0;
    const observed: D1Database = {
      prepare(query) {
        return database.prepare(query);
      },
      async batch(statements) {
        batches += 1;
        return database.batch(statements);
      },
    };
    await expect(
      reconcileControlD1CandidateRelease(observed, plan, {
        environment: "staging",
        sourceCommit: SOURCE_COMMIT,
        manifestDigest: plan.manifestDigest,
        candidateDatabaseId,
        sourceExportSha256,
        expectedFenceDigest: `sha256:${"1".repeat(64)}`,
        confirmReleaseReadinessDigest: `sha256:${"2".repeat(64)}`,
        releasedAt: "2026-07-16T00:01:00.000Z",
      }),
    ).rejects.toThrow("candidate_release_receipt_unavailable");
    expect(batches).toBe(0);
  } finally {
    database.close();
  }
});

test("control D1 CLI candidate-release-status reconciles an exact inactive receipt without a release batch", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  const candidateDatabaseId = "control_candidate_status";
  const sourceExportSha256 = `sha256:${"1".repeat(64)}`;
  const releaseReadinessDigest = `sha256:${"2".repeat(64)}`;
  const releasedAt = "2026-07-16T00:01:00.000Z";
  try {
    const applied = await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "staging",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
      databaseRole: "candidate",
      releasePolicy: "cutover",
      databaseId: candidateDatabaseId,
      sourceExportSha256,
    });
    const fenceDigest = await digestControlD1MaintenanceFence(
      applied.maintenanceFence,
    );
    await releaseControlD1Candidate(database, plan, {
      environment: "staging",
      sourceCommit: SOURCE_COMMIT,
      manifestDigest: plan.manifestDigest,
      candidateDatabaseId,
      sourceExportSha256,
      expectedFenceDigest: fenceDigest,
      confirmReleaseReadinessDigest: releaseReadinessDigest,
      releasedAt,
    });
    let batches = 0;
    const observed: D1Database = {
      prepare(query) {
        return database.prepare(query);
      },
      async batch(statements) {
        batches += 1;
        return database.batch(statements);
      },
    };
    const output: string[] = [];
    const code = await runControlD1SchemaCli(
      [
        "candidate-release-status",
        "--environment",
        "staging",
        "--confirm-manifest",
        plan.manifestDigest,
        "--confirm-database-id",
        candidateDatabaseId,
        "--confirm-source-export-sha256",
        sourceExportSha256,
        "--confirm-fence-digest",
        fenceDigest,
        "--confirm-release-readiness-digest",
        releaseReadinessDigest,
        "--released-at",
        releasedAt,
      ],
      {},
      (value) => output.push(value),
      {
        sourceCommit: SOURCE_COMMIT,
        now: () => releasedAt,
        inspectSourceCheckout: async () => ({
          head: SOURCE_COMMIT,
          clean: true,
        }),
        createRemoteDatabase: () => ({
          database: observed,
          configurationDigest: `sha256:${"3".repeat(64)}`,
          databaseId: candidateDatabaseId,
        }),
      },
    );
    expect(code).toBe(0);
    expect(batches).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      mode: "candidate-release-status",
      status: "released",
      lostAcknowledgementReconciled: true,
      maintenanceFenceDigest: fenceDigest,
    });
  } finally {
    database.close();
  }
});

test("control D1 candidate verification rejects a same-name no-op guard trigger", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  const candidateDatabaseId = "control_candidate_staging";
  const sourceExportSha256 = `sha256:${"4".repeat(64)}`;
  try {
    const applied = await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "staging",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
      databaseRole: "candidate",
      releasePolicy: "cutover",
      databaseId: candidateDatabaseId,
      sourceExportSha256,
    });
    await database
      .prepare(`drop trigger "_takosumi_schema_fence_workspaces_insert"`)
      .run();
    await database
      .prepare(
        `create trigger "_takosumi_schema_fence_workspaces_insert"
         before insert on "workspaces"
         begin
           select 1;
         end`,
      )
      .run();
    const verified = await verifyControlD1Candidate(database, plan, {
      environment: "staging",
      sourceCommit: SOURCE_COMMIT,
      manifestDigest: plan.manifestDigest,
      candidateDatabaseId,
      sourceExportSha256,
      expectedFenceDigest: await digestControlD1MaintenanceFence(
        applied.maintenanceFence,
      ),
    });
    expect(verified.status).toBe("mismatch");
    expect(verified.issues).toContain("maintenance_guard_inventory_mismatch");
    expect(verified.guardInventory?.triggerSqlDigests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "_takosumi_schema_fence_workspaces_insert",
        }),
      ]),
    );
  } finally {
    database.close();
  }
});

test("control D1 candidate release rejects a same-id fence change during the atomic release", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  const candidateDatabaseId = "control_candidate_staging";
  const sourceExportSha256 = `sha256:${"5".repeat(64)}`;
  try {
    const applied = await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "staging",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
      databaseRole: "candidate",
      releasePolicy: "cutover",
      databaseId: candidateDatabaseId,
      sourceExportSha256,
    });
    const fenceDigest = await digestControlD1MaintenanceFence(
      applied.maintenanceFence,
    );
    let batchCalls = 0;
    const raced: D1Database = {
      prepare(query) {
        return database.prepare(query);
      },
      async batch(statements) {
        batchCalls += 1;
        await database
          .prepare(
            `update _takosumi_control_schema_maintenance
             set activated_at = ? where singleton = 1`,
          )
          .bind("2026-07-16T00:00:01.000Z")
          .run();
        return await database.batch(statements);
      },
    };
    await expect(
      releaseControlD1Candidate(raced, plan, {
        environment: "staging",
        sourceCommit: SOURCE_COMMIT,
        manifestDigest: plan.manifestDigest,
        candidateDatabaseId,
        sourceExportSha256,
        expectedFenceDigest: fenceDigest,
        confirmReleaseReadinessDigest: `sha256:${"6".repeat(64)}`,
        releasedAt: "2026-07-16T00:01:00.000Z",
      }),
    ).rejects.toThrow("maintenance_fence_release_mismatch");
    expect(batchCalls).toBe(1);
    expect(await readControlD1MaintenanceState(database)).toMatchObject({
      status: "active",
      fence: {
        fenceId: applied.maintenanceFence.fenceId,
        activatedAt: "2026-07-16T00:00:01.000Z",
      },
    });
    const triggers = await database
      .prepare(
        `select count(*) as count from sqlite_master
         where type = 'trigger' and name like '_takosumi_schema_fence_%'`,
      )
      .first<{ readonly count: number }>();
    expect(Number(triggers?.count)).toBeGreaterThan(0);
  } finally {
    database.close();
  }
});

test("control D1 candidate verification fails closed when foreign key check is malformed", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  const candidateDatabaseId = "control_candidate_staging";
  const sourceExportSha256 = `sha256:${"7".repeat(64)}`;
  try {
    const applied = await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "staging",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      retainMaintenanceFence: true,
      databaseRole: "candidate",
      releasePolicy: "cutover",
      databaseId: candidateDatabaseId,
      sourceExportSha256,
    });
    const malformed: D1Database = {
      prepare(query) {
        if (query.trim().toLowerCase() === "pragma foreign_key_check") {
          return {
            bind() {
              return this;
            },
            first: async () => null,
            all: async () => ({ success: true }),
            run: async () => ({ success: true }),
          };
        }
        return database.prepare(query);
      },
      batch: database.batch.bind(database),
    };
    const verified = await verifyControlD1Candidate(malformed, plan, {
      environment: "staging",
      sourceCommit: SOURCE_COMMIT,
      manifestDigest: plan.manifestDigest,
      candidateDatabaseId,
      sourceExportSha256,
      expectedFenceDigest: await digestControlD1MaintenanceFence(
        applied.maintenanceFence,
      ),
    });
    expect(verified.integrity.foreignKeyCheck).toBe("mismatch");
    expect(verified.integrity.status).toBe("mismatch");
    expect(verified.status).toBe("mismatch");
    expect(verified.issues).toContain("database_integrity_mismatch");
  } finally {
    database.close();
  }
});

test("control D1 CLI releases only the exact retained in-place fence", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    const dependencies = {
      sourceCommit: SOURCE_COMMIT,
      now: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      inspectSourceCheckout: async () => ({
        head: SOURCE_COMMIT,
        clean: true,
      }),
      createRemoteDatabase: () => ({
        database,
        configurationDigest: `sha256:${"1".repeat(64)}`,
        databaseId: "database_staging",
      }),
    };
    const freezeOutput: string[] = [];
    const freezeCode = await runControlD1SchemaCli(
      [
        "freeze",
        "--environment",
        "staging",
        "--confirm-manifest",
        plan.manifestDigest,
      ],
      {},
      (value) => freezeOutput.push(value),
      dependencies,
    );
    expect(freezeCode).toBe(0);
    const freezeTranscript = JSON.parse(freezeOutput.at(-1) ?? "{}") as {
      readonly maintenanceFence: { readonly fenceId: string };
    };
    expect(freezeOutput.at(-1)).toContain('"mode": "freeze"');
    const output: string[] = [];
    const code = await runControlD1SchemaCli(
      [
        "release",
        "--environment",
        "staging",
        "--confirm-manifest",
        plan.manifestDigest,
      ],
      {},
      (value) => output.push(value),
      {
        ...dependencies,
        now: () => "2026-08-05T12:00:05.000Z",
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      mode: "release",
      status: "released",
      maintenanceStatus: "released",
      maintenanceFence: {
        fenceId: freezeTranscript.maintenanceFence.fenceId,
      },
    });
    expect(await readControlD1MaintenanceState(database)).toEqual({
      status: "inactive",
    });
    const retryOutput: string[] = [];
    const retryCode = await runControlD1SchemaCli(
      [
        "release",
        "--environment",
        "staging",
        "--confirm-manifest",
        plan.manifestDigest,
      ],
      {},
      (value) => retryOutput.push(value),
      {
        ...dependencies,
        now: () => "2026-08-05T12:00:10.000Z",
      },
    );
    expect(retryCode).toBe(0);
    expect(JSON.parse(retryOutput.at(-1) ?? "{}")).toMatchObject({
      mode: "release",
      status: "released",
      maintenanceStatus: "released",
      maintenanceFence: {
        fenceId: freezeTranscript.maintenanceFence.fenceId,
      },
    });
  } finally {
    database.close();
  }
});

test("control D1 CLI release rejects a substituted retained fence", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    await acquireControlD1MaintenanceFence(
      database,
      {
        sourceCommit: PREDECESSOR_SOURCE_COMMIT,
        manifestDigest: plan.manifestDigest,
        environment: "staging",
        databaseRole: "in_place",
        releasePolicy: "in_place",
        databaseId: "database_staging",
      },
      NOW,
    );
    const output: string[] = [];
    const code = await runControlD1SchemaCli(
      [
        "release",
        "--environment",
        "staging",
        "--confirm-manifest",
        plan.manifestDigest,
      ],
      {},
      (value) => output.push(value),
      {
        sourceCommit: SOURCE_COMMIT,
        now: () => "2026-08-05T12:00:05.000Z",
        inspectSourceCheckout: async () => ({
          head: SOURCE_COMMIT,
          clean: true,
        }),
        createRemoteDatabase: () => ({
          database,
          configurationDigest: `sha256:${"1".repeat(64)}`,
          databaseId: "database_staging",
        }),
      },
    );
    expect(code).toBe(1);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      mode: "release",
      status: "failed",
      failureCode: "maintenance_fence_release_mismatch",
    });
    expect((await readControlD1MaintenanceState(database)).status).toBe(
      "active",
    );
  } finally {
    database.close();
  }
});

test("control D1 CLI apply requires exact manifest confirmation", async () => {
  const output: string[] = [];
  const code = await runControlD1SchemaCli(
    ["apply", "--environment", "production"],
    {},
    (value) => output.push(value),
    { sourceCommit: SOURCE_COMMIT, now: () => NOW },
  );
  expect(code).toBe(1);
  expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
    status: "failed",
    failureCode: "manifest_confirmation_required",
  });
});

test("control D1 CLI predecessor confirmations are paired and apply-only", async () => {
  for (const argv of [
    ["apply", "--confirm-predecessor-source", PREDECESSOR_SOURCE_COMMIT],
    [
      "verify",
      "--confirm-predecessor-source",
      PREDECESSOR_SOURCE_COMMIT,
      "--confirm-predecessor-manifest",
      PREDECESSOR_MANIFEST_DIGEST,
    ],
    [
      "apply",
      "--dry-run",
      "--confirm-predecessor-source",
      PREDECESSOR_SOURCE_COMMIT,
      "--confirm-predecessor-manifest",
      PREDECESSOR_MANIFEST_DIGEST,
    ],
  ]) {
    const output: string[] = [];
    const code = await runControlD1SchemaCli(
      argv,
      {},
      (value) => output.push(value),
      { sourceCommit: SOURCE_COMMIT, now: () => NOW },
    );
    expect(code).toBe(1);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
      status: "failed",
      failureCode: "arguments_invalid",
    });
  }
});

test("control D1 CLI reports the exact predecessor fence transition on recovery", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    await seedImmediatePredecessorV63(database);
    const predecessorFence = await acquireControlD1MaintenanceFence(
      database,
      {
        sourceCommit: PREDECESSOR_SOURCE_COMMIT,
        manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
        environment: "staging",
        databaseRole: "in_place",
        releasePolicy: "in_place",
        databaseId: "database_staging",
      },
      NOW,
    );
    const output: string[] = [];
    const code = await runControlD1SchemaCli(
      [
        "apply",
        "--environment",
        "staging",
        "--confirm-manifest",
        plan.manifestDigest,
        "--retain-maintenance-fence",
        "--confirm-predecessor-source",
        PREDECESSOR_SOURCE_COMMIT,
        "--confirm-predecessor-manifest",
        PREDECESSOR_MANIFEST_DIGEST,
      ],
      {},
      (value) => output.push(value),
      {
        sourceCommit: SOURCE_COMMIT,
        now: () => NOW,
        maintenanceDrainMilliseconds: 0,
        waitForRequestDrain: async () => {},
        inspectSourceCheckout: async () => ({
          head: SOURCE_COMMIT,
          clean: true,
        }),
        createRemoteDatabase: () => ({
          database,
          configurationDigest: `sha256:${"1".repeat(64)}`,
          databaseId: "database_staging",
        }),
      },
    );
    const transcript = JSON.parse(output.at(-1) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(code).toBe(0);
    expect(transcript).toMatchObject({
      status: "ready",
      appliedMigrationVersions: [64],
      maintenanceFenceTransition: {
        predecessorSourceCommit: PREDECESSOR_SOURCE_COMMIT,
        predecessorManifestDigest: PREDECESSOR_MANIFEST_DIGEST,
        predecessorFenceId: predecessorFence.fenceId,
      },
    });
    const transition = transcript.maintenanceFenceTransition as Record<
      string,
      unknown
    >;
    expect(Object.keys(transition).sort()).toEqual([
      "predecessorFenceId",
      "predecessorManifestDigest",
      "predecessorSourceCommit",
      "successorFenceId",
    ]);
    const state = await readControlD1MaintenanceState(database);
    expect(state.status).toBe("active");
    if (state.status !== "active") throw new Error("expected active fence");
    expect(transition.successorFenceId).toBe(state.fence.fenceId);
  } finally {
    database.close();
  }
});

test("control D1 CLI preserves the fence transition on post-apply schema mismatch", async () => {
  const plan = await buildControlD1SchemaPlan();
  const database = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(database);
    await seedImmediatePredecessorV63(database);
    await database
      .prepare(
        `create trigger unexpected_workspace_trigger
         after insert on workspaces
         begin
           select 1;
         end`,
      )
      .run();
    const predecessorFence = await acquireControlD1MaintenanceFence(
      database,
      {
        sourceCommit: PREDECESSOR_SOURCE_COMMIT,
        manifestDigest: PREDECESSOR_MANIFEST_DIGEST,
        environment: "staging",
        databaseRole: "in_place",
        releasePolicy: "in_place",
        databaseId: "database_staging",
      },
      NOW,
    );
    const output: string[] = [];
    const code = await runControlD1SchemaCli(
      [
        "apply",
        "--environment",
        "staging",
        "--confirm-manifest",
        plan.manifestDigest,
        "--confirm-predecessor-source",
        PREDECESSOR_SOURCE_COMMIT,
        "--confirm-predecessor-manifest",
        PREDECESSOR_MANIFEST_DIGEST,
      ],
      {},
      (value) => output.push(value),
      {
        sourceCommit: SOURCE_COMMIT,
        now: () => NOW,
        maintenanceDrainMilliseconds: 0,
        waitForRequestDrain: async () => {},
        inspectSourceCheckout: async () => ({
          head: SOURCE_COMMIT,
          clean: true,
        }),
        createRemoteDatabase: () => ({
          database,
          configurationDigest: `sha256:${"1".repeat(64)}`,
          databaseId: "database_staging",
        }),
      },
    );
    const transcript = JSON.parse(output.at(-1) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(code).toBe(1);
    expect(transcript).toMatchObject({
      status: "failed",
      failureCode: "post_apply_verification_failed",
      maintenanceFenceTransition: {
        predecessorSourceCommit: PREDECESSOR_SOURCE_COMMIT,
        predecessorManifestDigest: PREDECESSOR_MANIFEST_DIGEST,
        predecessorFenceId: predecessorFence.fenceId,
      },
    });
    const transition = transcript.maintenanceFenceTransition as Record<
      string,
      unknown
    >;
    expect(Object.keys(transition).sort()).toEqual([
      "predecessorFenceId",
      "predecessorManifestDigest",
      "predecessorSourceCommit",
      "successorFenceId",
    ]);
    const state = await readControlD1MaintenanceState(database);
    expect(state.status).toBe("active");
    if (state.status !== "active") throw new Error("expected active fence");
    expect(transition.successorFenceId).toBe(state.fence.fenceId);
    expect(
      await database
        .prepare(`select max(version) as version from schema_migrations`)
        .first(),
    ).toEqual({ version: 64 });
    await expect(
      database
        .prepare(
          `insert into workspaces
             (id, handle, record_json, created_at, updated_at)
           values ('mismatch-blocked', 'mismatch-blocked', '{}', ?, ?)`,
        )
        .bind(NOW, NOW)
        .run(),
    ).rejects.toThrow("takosumi control schema maintenance");
  } finally {
    database.close();
  }
});

test("control D1 CLI exposes stable maintenance codes without raw detail", async () => {
  const planOutput: string[] = [];
  expect(
    await runControlD1SchemaCli(
      ["plan"],
      {},
      (value) => planOutput.push(value),
      { sourceCommit: SOURCE_COMMIT, now: () => NOW },
    ),
  ).toBe(0);
  const manifestDigest = JSON.parse(planOutput.at(-1) ?? "{}")
    .manifestDigest as string;
  const output: string[] = [];
  const code = await runControlD1SchemaCli(
    ["apply", "--environment", "staging", "--confirm-manifest", manifestDigest],
    {},
    (value) => output.push(value),
    {
      sourceCommit: SOURCE_COMMIT,
      now: () => NOW,
      inspectSourceCheckout: async () => ({
        head: SOURCE_COMMIT,
        clean: true,
      }),
      createRemoteDatabase: () => {
        throw new ControlD1MaintenanceError(
          "maintenance_table_name_invalid:secret-token remote detail",
        );
      },
    },
  );
  expect(code).toBe(1);
  expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
    status: "failed",
    failureCode: "maintenance_table_name_invalid",
  });
  expect(output.join("\n")).not.toContain("secret-token");
  expect(output.join("\n")).not.toContain("remote detail");
});

test("control D1 CLI rejects a dirty source before opening the remote target", async () => {
  const planOutput: string[] = [];
  expect(
    await runControlD1SchemaCli(
      ["plan"],
      {},
      (value) => planOutput.push(value),
      { sourceCommit: SOURCE_COMMIT, now: () => NOW },
    ),
  ).toBe(0);
  const manifestDigest = JSON.parse(planOutput.at(-1) ?? "{}")
    .manifestDigest as string;
  let remoteCalls = 0;
  const output: string[] = [];
  const code = await runControlD1SchemaCli(
    ["apply", "--environment", "staging", "--confirm-manifest", manifestDigest],
    {},
    (value) => output.push(value),
    {
      sourceCommit: SOURCE_COMMIT,
      now: () => NOW,
      inspectSourceCheckout: async () => ({
        head: SOURCE_COMMIT,
        clean: false,
      }),
      createRemoteDatabase: () => {
        remoteCalls += 1;
        throw new Error("remote must not be opened");
      },
    },
  );
  expect(code).toBe(1);
  expect(remoteCalls).toBe(0);
  expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({
    status: "failed",
    failureCode: "source_checkout_dirty",
  });
});

test("control D1 REST adapter emits the documented single and batch shapes", async () => {
  const requests: { readonly url: string; readonly body: unknown }[] = [];
  const database = new CloudflareControlD1RestDatabase({
    accountId: "account_123",
    databaseId: "database_456",
    apiToken: "secret-token",
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return Response.json({
        success: true,
        result: [{ success: true, results: [{ value: "ready" }] }],
      });
    },
  });

  const first = await database
    .prepare("select ? as value")
    .bind("ready")
    .first<{ readonly value: string }>();
  expect(first).toEqual({ value: "ready" });
  await database.batch([
    database.prepare("insert into demo (id) values (?)").bind("one"),
    database.prepare("insert into demo (id) values (?)").bind("two"),
  ]);

  expect(requests[0]).toEqual({
    url: "https://api.cloudflare.com/client/v4/accounts/account_123/d1/database/database_456/query",
    body: { sql: "select ? as value", params: ["ready"] },
  });
  expect(requests[1]?.body).toEqual({
    batch: [
      { sql: "insert into demo (id) values (?)", params: ["one"] },
      { sql: "insert into demo (id) values (?)", params: ["two"] },
    ],
  });
  expect(JSON.stringify(requests)).not.toContain("secret-token");
});

test("control D1 REST imports compound trigger batches and resolves only after poll completion", async () => {
  const backing = new SqliteControlD1Database();
  const { fetch, stats } = createD1RestAndImportFetch(backing, {
    pendingPolls: 2,
  });
  const database = new CloudflareControlD1RestDatabase({
    accountId: "account_123",
    databaseId: "database_456",
    apiToken: "secret-token",
    fetch,
    importPollIntervalMilliseconds: 0,
    wait: async () => {},
  });
  const value = "quote'\n-- ? /* */\u0000雪";
  try {
    const statements = [
      database.prepare(
        `create table demo (id text primary key, value text, optional integer)`,
      ),
      database.prepare(
        `create trigger demo_blocked_insert
         before insert on demo
         when new.id = 'blocked ?'
         begin
           select raise(abort, 'blocked ?');
         end;`,
      ),
      database
        .prepare(
          `insert into demo (id, value, optional) values (?, ?, ?) /* ? */`,
        )
        .bind("safe", value, null),
    ];
    const result = await database.batch(statements);

    expect(result).toHaveLength(statements.length);
    expect(result.every((entry) => entry.success === true)).toBe(true);
    expect(stats.polls).toBe(2);
    expect(stats.importIngests).toBe(1);
    expect(stats.queryTriggerRejections).toBe(0);
    expect(stats.uploadAuthorizationHeaders).toEqual([null]);
    expect(stats.uploadedSql).toHaveLength(1);
    expect(stats.uploadedSql[0]).not.toContain(value);
    expect(stats.uploadedSql[0]).toContain("CAST(X'");
    expect(stats.uploadedSql[0]).not.toContain("end;;");
    expect(stats.uploadedSql[0]).toContain(
      "optional integer);\ncreate trigger",
    );
    expect(
      await backing
        .prepare(`select id, hex(value) as value_hex, optional from demo`)
        .first(),
    ).toEqual({
      id: "safe",
      value_hex: [...new TextEncoder().encode(value)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase(),
      optional: null,
    });
    await expect(
      backing
        .prepare(
          `insert into demo (id, value, optional) values ('blocked ?', '', null)`,
        )
        .run(),
    ).rejects.toThrow("blocked ?");
  } finally {
    backing.close();
  }
});

test("control D1 REST compound renderer fails closed on bind mismatch", async () => {
  let fetchCalls = 0;
  const database = new CloudflareControlD1RestDatabase({
    accountId: "account_123",
    databaseId: "database_456",
    apiToken: "secret-token",
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("fetch must not run");
    },
  });
  await expect(
    database.batch([
      database.prepare(
        `create trigger invalid before insert on demo begin select ?; end;`,
      ),
    ]),
  ).rejects.toThrow("query_parameter_mismatch");
  expect(fetchCalls).toBe(0);
});

test("control D1 REST import transport converges the live v24 fixture through canonical v50 triggers", async () => {
  const plan = await buildControlD1SchemaPlan();
  const backing = new SqliteControlD1Database();
  const sql = await Bun.file(
    resolve(
      import.meta.dir,
      "../../fixtures/control-d1-live-v24/staging-schema.sql",
    ),
  ).text();
  try {
    backing.exec(sql);
    for (const migration of plan.migrations.filter(
      (entry) => entry.version <= 24,
    )) {
      await backing
        .prepare(
          `insert into schema_migrations (version, name, checksum, applied_at)
           values (?, ?, ?, ?)`,
        )
        .bind(migration.version, migration.name, migration.checksum, NOW)
        .run();
    }
    await seedLiveV24ConvergenceRows(backing, "staging");
    const before = await readLiveV24ConvergenceRows(backing);
    const { fetch, stats } = createD1RestAndImportFetch(backing);
    const database = new CloudflareControlD1RestDatabase({
      accountId: "account_123",
      databaseId: "database_456",
      apiToken: "secret-token",
      fetch,
      importPollIntervalMilliseconds: 0,
      wait: async () => {},
    });

    const applied = await applyControlD1Schema(database, plan, {
      sourceCommit: SOURCE_COMMIT,
      environment: "staging",
      activatedAt: NOW,
      releasedAt: () => NOW,
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
    });

    expect(applied.beforeMigrationVersions.at(-1)).toBe(24);
    expect(applied.appliedMigrationVersions).toEqual(
      plan.migrations
        .filter((entry) => entry.version >= 25)
        .map((entry) => entry.version),
    );
    expect(applied.verification.status).toBe("ready");
    expect(applied.verification.latestMigrationVersion).toBe(64);
    expect(stats.importIngests).toBeGreaterThan(0);
    expect(stats.queryTriggerRejections).toBe(0);
    expect(await readLiveV24ConvergenceRows(backing)).toEqual(before);
    const formTriggers = await backing
      .prepare(
        `select name from sqlite_master
         where type = 'trigger' and name like '%_form_identity_pair_%'
         order by name`,
      )
      .all<{ readonly name: string }>();
    expect((formTriggers.results ?? []).map((row) => row.name)).toEqual([
      "resolution_locks_form_identity_pair_insert",
      "resolution_locks_form_identity_pair_update",
      "resource_shapes_form_identity_pair_insert",
      "resource_shapes_form_identity_pair_update",
    ]);
  } finally {
    backing.close();
  }
});

test("control D1 REST failures expose only a stable code", async () => {
  const database = new CloudflareControlD1RestDatabase({
    accountId: "account_123",
    databaseId: "database_456",
    apiToken: "secret-token",
    fetch: async () =>
      Response.json(
        { success: false, errors: [{ message: "secret-token remote detail" }] },
        { status: 500 },
      ),
  });

  let failure: unknown;
  try {
    await database.prepare("select 1").all();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ControlD1RestError);
  expect(String(failure)).toContain("cloudflare_d1_query_failed");
  expect(String(failure)).not.toContain("secret-token");
  expect(String(failure)).not.toContain("remote detail");
});
