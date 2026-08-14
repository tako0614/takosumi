import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildControlD1SchemaPlan,
  readControlD1ReleaseStatus,
  releaseControlD1InPlaceRecovery,
  SqliteControlD1Database,
  type ControlD1ReleaseStatus,
  type ControlD1SchemaPlan,
} from "./control_d1_schema.ts";
import { CloudflareControlD1RestDatabase } from "./control_d1_schema_rest.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../worker/src/d1_opentofu_store.ts";
import {
  acquireControlD1MaintenanceFence,
  CONTROL_D1_MAINTENANCE_RELEASE_ASSERTION_TABLE,
  CONTROL_D1_MAINTENANCE_RELEASE_GUARDS_TABLE,
  CONTROL_D1_MAINTENANCE_RELEASE_MIGRATIONS_TABLE,
  readControlD1MaintenanceGuardInventory,
  readControlD1MaintenanceState,
  type ControlD1MaintenanceReleasePlanMetrics,
} from "../../worker/src/d1_schema_maintenance.ts";

export const CONTROL_D1_RELEASE_RECOVERY_CAPABILITY_KIND =
  "takosumi.oss-control-d1-release-recovery-capability@v2" as const;
export const CONTROL_D1_RELEASE_RECOVERY_CAPABILITY_VERSION = 2 as const;
export const CONTROL_D1_RELEASE_RECOVERY_CAPABILITY_COMMAND =
  "bun scripts/control-d1-schema.ts release-recovery-capability" as const;

const USER_TABLE_COUNT = 221 as const;
const GUARDED_TABLE_COUNT = 219 as const;
const GUARD_TRIGGER_COUNT = 657 as const;
const RELEASED_AT = "2026-08-05T12:00:05.000Z" as const;
const ACTIVATED_AT = "2026-08-05T12:00:00.000Z" as const;
const FIXTURE_DATABASE_ID = "d".repeat(128);
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

const SOURCE_FILES = [
  "deploy/platform/control_d1_schema.ts",
  "deploy/platform/control_d1_schema_cli.ts",
  "deploy/platform/control_d1_schema_rest.ts",
  "deploy/platform/control_d1_release_recovery_capability.ts",
  "worker/src/d1_schema_maintenance.ts",
  "tests/deploy/platform/control_d1_release_recovery_capability_test.ts",
] as const;

export interface ControlD1ReleaseRecoveryCapabilityOptions {
  readonly root?: string;
  readonly sourceCommit: string;
  readonly toolVersion?: string;
  readonly packageVersion?: string;
}

export interface ControlD1ReleaseRecoveryCapability {
  readonly kind: typeof CONTROL_D1_RELEASE_RECOVERY_CAPABILITY_KIND;
  readonly version: typeof CONTROL_D1_RELEASE_RECOVERY_CAPABILITY_VERSION;
  readonly status: "ready";
  readonly sourceCommit: string;
  readonly tool: {
    readonly name: "bun";
    readonly version: string;
    readonly packageVersion: string;
    readonly command: typeof CONTROL_D1_RELEASE_RECOVERY_CAPABILITY_COMMAND;
  };
  readonly scope: {
    readonly evidenceClass: "provider_neutral_worst_case_regression";
    readonly providerNeutralOnly: true;
    readonly userTableCount: typeof USER_TABLE_COUNT;
    readonly guardedTableCount: typeof GUARDED_TABLE_COUNT;
    readonly guardTriggerCount: typeof GUARD_TRIGGER_COUNT;
  };
  readonly plan: ControlD1MaintenanceReleasePlanMetrics;
  readonly exactShapeSuccess: {
    readonly statusDigest: string;
    readonly releaseReadinessDigest: string;
    readonly releaseAuthorizationDigest: string;
    readonly importCount: 1;
    readonly importBytes: number;
    readonly importDigest: string;
    readonly inactiveReceiptExact: true;
    readonly guardTriggerCountAfter: 0;
    readonly reservedRelationsAbsentAfter: true;
  };
  readonly injectedMidImportRollback: {
    readonly injectionPoint: "before_expected_migration_insert";
    readonly importAttemptCount: 1;
    readonly releaseRejected: true;
    readonly maintenanceFenceActiveAfter: true;
    readonly guardTriggerCountAfter: typeof GUARD_TRIGGER_COUNT;
    readonly reservedRelationsAbsentAfter: true;
  };
  readonly targetAuthorization: {
    readonly status: "not_authorized";
    readonly localSQLiteIsNotTargetAuthorization: true;
    readonly disposableLiveD1EvidenceRequired: true;
    readonly requiredEvidenceKind: "takosumi.control-d1-release-recovery-live-evidence@v1";
    readonly requiredEvidence: readonly [
      "exact_shape_success",
      "injected_mid_import_rollback",
    ];
  };
  readonly sourceFiles: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly sourceFilesDigest: string;
  readonly digest: string;
}

export async function buildControlD1ReleaseRecoveryCapability(
  options: ControlD1ReleaseRecoveryCapabilityOptions,
): Promise<ControlD1ReleaseRecoveryCapability> {
  if (!SOURCE_COMMIT_PATTERN.test(options.sourceCommit)) {
    throw new ControlD1ReleaseRecoveryCapabilityError(
      "source_commit_invalid",
    );
  }
  const root = resolve(options.root ?? resolve(import.meta.dir, "../.."));
  const packageJson = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  ) as { readonly version?: unknown };
  const packageVersion =
    options.packageVersion ?? String(packageJson.version ?? "").trim();
  const toolVersion = options.toolVersion ?? Bun.version;
  if (!toolVersion || !packageVersion) {
    throw new ControlD1ReleaseRecoveryCapabilityError(
      "tool_provenance_invalid",
    );
  }
  const plan = await buildControlD1SchemaPlan();
  const success = await runRecoveryFixture(plan, options.sourceCommit, false);
  if (
    success.activeStatus?.status !== "ready" ||
    success.releaseStatus?.status !== "released" ||
    !success.plan ||
    success.maintenanceStatus !== "inactive" ||
    success.guardTriggerCountAfter !== 0 ||
    !success.reservedRelationsAbsentAfter ||
    success.releaseRejected
  ) {
    throw new ControlD1ReleaseRecoveryCapabilityError(
      "recovery_success_evidence_invalid",
    );
  }
  const rollback = await runRecoveryFixture(plan, options.sourceCommit, true);
  if (
    !rollback.releaseRejected ||
    rollback.maintenanceStatus !== "active" ||
    rollback.guardTriggerCountAfter !== GUARD_TRIGGER_COUNT ||
    !rollback.reservedRelationsAbsentAfter
  ) {
    throw new ControlD1ReleaseRecoveryCapabilityError(
      "recovery_rollback_evidence_invalid",
    );
  }
  const sourceFiles = await Promise.all(
    SOURCE_FILES.map(async (path) => {
      const bytes = await readFile(resolve(root, path));
      return {
        path,
        bytes: bytes.byteLength,
        sha256: digestBytes(bytes),
      };
    }),
  );
  const body = {
    kind: CONTROL_D1_RELEASE_RECOVERY_CAPABILITY_KIND,
    version: CONTROL_D1_RELEASE_RECOVERY_CAPABILITY_VERSION,
    status: "ready" as const,
    sourceCommit: options.sourceCommit,
    tool: {
      name: "bun" as const,
      version: toolVersion,
      packageVersion,
      command: CONTROL_D1_RELEASE_RECOVERY_CAPABILITY_COMMAND,
    },
    scope: {
      evidenceClass: "provider_neutral_worst_case_regression" as const,
      providerNeutralOnly: true as const,
      userTableCount: USER_TABLE_COUNT,
      guardedTableCount: GUARDED_TABLE_COUNT,
      guardTriggerCount: GUARD_TRIGGER_COUNT,
    },
    plan: success.plan,
    exactShapeSuccess: {
      statusDigest: success.activeStatus.statusDigest,
      releaseReadinessDigest: success.activeStatus.releaseReadinessDigest,
      releaseAuthorizationDigest:
        success.activeStatus.releaseAuthorizationDigest,
      importCount: 1 as const,
      importBytes: success.importBytes,
      importDigest: success.importDigest,
      inactiveReceiptExact: true as const,
      guardTriggerCountAfter: 0 as const,
      reservedRelationsAbsentAfter: true as const,
    },
    injectedMidImportRollback: {
      injectionPoint: "before_expected_migration_insert" as const,
      importAttemptCount: 1 as const,
      releaseRejected: true as const,
      maintenanceFenceActiveAfter: true as const,
      guardTriggerCountAfter: GUARD_TRIGGER_COUNT,
      reservedRelationsAbsentAfter: true as const,
    },
    targetAuthorization: {
      status: "not_authorized" as const,
      localSQLiteIsNotTargetAuthorization: true as const,
      disposableLiveD1EvidenceRequired: true as const,
      requiredEvidenceKind:
        "takosumi.control-d1-release-recovery-live-evidence@v1" as const,
      requiredEvidence: [
        "exact_shape_success",
        "injected_mid_import_rollback",
      ] as const,
    },
    sourceFiles,
    sourceFilesDigest: digestJson(sourceFiles),
  };
  return { ...body, digest: digestJson(body) };
}

interface RecoveryFixtureResult {
  readonly activeStatus: ControlD1ReleaseStatus | null;
  readonly releaseStatus: ControlD1ReleaseStatus | null;
  readonly plan: ControlD1MaintenanceReleasePlanMetrics | null;
  readonly importBytes: number;
  readonly importDigest: string;
  readonly releaseRejected: boolean;
  readonly maintenanceStatus: "active" | "inactive";
  readonly guardTriggerCountAfter: number;
  readonly reservedRelationsAbsentAfter: boolean;
}

async function runRecoveryFixture(
  plan: ControlD1SchemaPlan,
  sourceCommit: string,
  injectFailure: boolean,
): Promise<RecoveryFixtureResult> {
  const backing = new SqliteControlD1Database();
  try {
    await ensureD1OpenTofuLedgerSchema(backing);
    addWorstCaseHostTables(backing, plan);
    await acquireControlD1MaintenanceFence(
      backing,
      {
        sourceCommit,
        manifestDigest: plan.manifestDigest,
        environment: "test",
        databaseRole: "in_place",
        releasePolicy: "in_place",
        databaseId: FIXTURE_DATABASE_ID,
      },
      ACTIVATED_AT,
    );
    const initialGuards = await readControlD1MaintenanceGuardInventory(backing);
    const userTableCount = await readUserTableCount(backing);
    if (
      userTableCount !== USER_TABLE_COUNT ||
      initialGuards.guardedTableCount !== GUARDED_TABLE_COUNT ||
      initialGuards.guardTriggerCount !== GUARD_TRIGGER_COUNT
    ) {
      throw new ControlD1ReleaseRecoveryCapabilityError(
        "worst_case_fixture_invalid",
      );
    }
    const harness = createProviderNeutralImportHarness(backing, injectFailure);
    const database = new CloudflareControlD1RestDatabase({
      accountId: "provider-neutral",
      databaseId: FIXTURE_DATABASE_ID,
      apiToken: "provider-neutral-placeholder",
      fetch: harness.fetch,
      importPollIntervalMilliseconds: 0,
      wait: async () => {},
    });
    const targetDigest = digestJson({
      kind: "takosumi.provider-neutral-recovery-target@v1",
      target: FIXTURE_DATABASE_ID,
    });
    const statusOptions = {
      currentToolSourceCommit: sourceCommit,
      environment: "test" as const,
      manifestDigest: plan.manifestDigest,
      targetDatabaseId: FIXTURE_DATABASE_ID,
      targetDigest,
      releasedAt: RELEASED_AT,
    };
    const activeStatus = await readControlD1ReleaseStatus(
      database,
      plan,
      statusOptions,
    );
    if (activeStatus.status !== "ready" || !activeStatus.releasePlan) {
      throw new ControlD1ReleaseRecoveryCapabilityError(
        "worst_case_status_not_ready",
      );
    }
    let releaseStatus: ControlD1ReleaseStatus | null = null;
    let releaseRejected = false;
    try {
      releaseStatus = await releaseControlD1InPlaceRecovery(database, plan, {
        ...statusOptions,
        confirmStatusDigest: activeStatus.statusDigest,
        confirmReleaseReadinessDigest: activeStatus.releaseReadinessDigest,
        confirmFenceId: activeStatus.fence.fenceId,
        confirmOriginalSourceCommit: activeStatus.fence.originalSourceCommit,
        confirmCurrentToolSourceCommit:
          activeStatus.fence.currentToolSourceCommit,
        confirmManifestDigest: activeStatus.fence.manifestDigest,
        confirmTargetDigest: activeStatus.fence.targetDigest,
      });
    } catch {
      releaseRejected = true;
    }
    const maintenance = await readControlD1MaintenanceState(backing);
    if (maintenance.status === "absent") {
      throw new ControlD1ReleaseRecoveryCapabilityError(
        "maintenance_receipt_absent",
      );
    }
    const guards = await readControlD1MaintenanceGuardInventory(backing);
    const reservedRelationsAbsentAfter =
      (await readReservedRelationCount(backing)) === 0;
    const uploadedSql = harness.stats.uploadedSql.at(-1) ?? "";
    if (
      harness.stats.importAttemptCount !== 1 ||
      !uploadedSql ||
      harness.stats.uploadAuthorizationHeaders.some((value) => value !== null)
    ) {
      throw new ControlD1ReleaseRecoveryCapabilityError(
        "provider_neutral_import_evidence_invalid",
      );
    }
    const importBytes = new TextEncoder().encode(uploadedSql).byteLength;
    const importDigest = digestText(uploadedSql);
    if (
      importBytes !== activeStatus.releasePlan.totalImportBytes ||
      importDigest !== activeStatus.releasePlan.digest
    ) {
      throw new ControlD1ReleaseRecoveryCapabilityError(
        "release_plan_import_mismatch",
      );
    }
    return {
      activeStatus,
      releaseStatus,
      plan: activeStatus.releasePlan,
      importBytes,
      importDigest,
      releaseRejected,
      maintenanceStatus: maintenance.status,
      guardTriggerCountAfter: guards.guardTriggerCount,
      reservedRelationsAbsentAfter,
    };
  } finally {
    backing.close();
  }
}

function addWorstCaseHostTables(
  database: SqliteControlD1Database,
  plan: ControlD1SchemaPlan,
): void {
  const hostTableCount = USER_TABLE_COUNT - plan.tables.length - 1;
  if (hostTableCount <= 0) {
    throw new ControlD1ReleaseRecoveryCapabilityError(
      "worst_case_fixture_invalid",
    );
  }
  database.exec(
    Array.from({ length: hostTableCount }, (_, index) => {
      const prefix = `host_extension_${String(index).padStart(3, "0")}_`;
      const table = `${prefix}${"x".repeat(128 - prefix.length)}`;
      return `create table "${table}" (id integer primary key);`;
    }).join("\n"),
  );
}

type RestQuery = {
  readonly sql: string;
  readonly params?: readonly (string | number | null)[];
};

function createProviderNeutralImportHarness(
  backing: SqliteControlD1Database,
  injectFailure: boolean,
) {
  const uploads = new Map<string, string>();
  const filenames = new Map<string, string>();
  const stats = {
    importAttemptCount: 0,
    uploadedSql: [] as string[],
    uploadAuthorizationHeaders: [] as (string | null)[],
  };
  const fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "provider-neutral-upload.example.test") {
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
      if (!("action" in body)) throw new Error("import action missing");
      if (body.action === "init") {
        const filename = `recovery-${body.etag}.sql`;
        filenames.set(filename, body.etag);
        return Response.json({
          success: true,
          result: {
            filename,
            upload_url: `https://provider-neutral-upload.example.test/${body.etag}`,
          },
        });
      }
      if (body.action === "ingest") {
        stats.importAttemptCount += 1;
        const etag = filenames.get(body.filename ?? "");
        const sql = etag ? uploads.get(etag) : undefined;
        if (!etag || etag !== body.etag || !sql) {
          return Response.json({
            success: true,
            result: { status: "error", error: "upload_missing" },
          });
        }
        const executedSql = injectFailure ? injectMidImportFailure(sql) : sql;
        try {
          backing.exec(`begin immediate;\n${executedSql}\ncommit;`);
        } catch {
          try {
            backing.exec("rollback");
          } catch {
            // The injected statement may fail before BEGIN; the capability
            // assertions below still require every reserved relation absent.
          }
          return Response.json({
            success: true,
            result: { status: "error", error: "injected_failure" },
          });
        }
        return Response.json({
          success: true,
          result: { status: "complete", success: true },
        });
      }
      throw new Error("unexpected Import poll");
    }
    if (!url.pathname.endsWith("/query") || "action" in body) {
      throw new Error("unexpected provider-neutral request");
    }
    const queries = "batch" in body ? body.batch : [body];
    try {
      const results =
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
      return Response.json({ success: true, result: results });
    } catch {
      return Response.json(
        { success: false, errors: [{ code: 7500, message: "SQLITE_ERROR" }] },
        { status: 400 },
      );
    }
  }) as typeof globalThis.fetch;
  return { fetch, stats };
}

function injectMidImportFailure(sql: string): string {
  const marker = `insert into "${CONTROL_D1_MAINTENANCE_RELEASE_MIGRATIONS_TABLE}"`;
  const index = sql.indexOf(marker);
  if (index < 0) {
    throw new ControlD1ReleaseRecoveryCapabilityError(
      "rollback_injection_point_missing",
    );
  }
  return (
    `${sql.slice(0, index)}` +
    `insert into "_takosumi_injected_missing_relation" values (1);\n` +
    sql.slice(index)
  );
}

async function readUserTableCount(
  database: SqliteControlD1Database,
): Promise<number> {
  const row = await database
    .prepare(
      `select count(*) as count from sqlite_master
       where type = 'table' and name not like 'sqlite_%'`,
    )
    .first<{ readonly count?: number | string }>();
  return Number(row?.count);
}

async function readReservedRelationCount(
  database: SqliteControlD1Database,
): Promise<number> {
  const row = await database
    .prepare(
      `select count(*) as count from sqlite_master where name in (?, ?, ?)`,
    )
    .bind(
      CONTROL_D1_MAINTENANCE_RELEASE_GUARDS_TABLE,
      CONTROL_D1_MAINTENANCE_RELEASE_MIGRATIONS_TABLE,
      CONTROL_D1_MAINTENANCE_RELEASE_ASSERTION_TABLE,
    )
    .first<{ readonly count?: number | string }>();
  return Number(row?.count);
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestJson(value: unknown): string {
  return digestText(JSON.stringify(value));
}

export class ControlD1ReleaseRecoveryCapabilityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ControlD1ReleaseRecoveryCapabilityError";
  }
}
