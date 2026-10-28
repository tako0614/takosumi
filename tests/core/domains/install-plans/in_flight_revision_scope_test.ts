import { expect, test } from "bun:test";
import { D1GitInstallPlanStore } from "../../../../core/domains/install-plans/d1_store.ts";
import { SqlGitInstallPlanStore } from "../../../../core/domains/install-plans/sql_store.ts";
import {
  InMemoryGitInstallPlanStore,
  type GitInstallPlanStore,
  type StoredGitInstallPlan,
} from "../../../../core/domains/install-plans/store.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const NOW = "2026-10-27T00:00:00.000Z";

function workspace(id: string) {
  return {
    id,
    handle: `handle-${id}`,
    displayName: id,
    type: "personal" as const,
    ownerUserId: `owner-${id}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** A revision coordinator row as `POST /capsules/:id/revision-plans` stores it. */
function revisionPlan(id: string, workspaceId: string, capsuleId: string): StoredGitInstallPlan {
  return {
    id,
    workspaceId,
    workspaceManagementAuthority: { workspaceId, managementState: "active", managementEpoch: 1 },
    createdBy: "user_one",
    actorSubject: "user_one",
    idempotencyKeyHash: `key_${id}`,
    requestDigest: `digest_${id}`,
    source: { name: "repo", url: "https://github.com/takos/example.git", ref: "main", path: "." },
    capsule: { name: "example", environment: "production" },
    options: {},
    phase: "syncing_source",
    generation: 0,
    createdAt: NOW,
    updatedAt: NOW,
    operation: "revision",
    sourceId: "src_revision",
    capsuleId,
    installConfigId: "cfg_revision",
    installConfigBaseId: "cfg_revision",
    installConfigBaseDigest: "sha256:config",
    installModulePath: ".",
    revision: {
      targetRef: "release/v2",
      base: {
        capsuleStateGeneration: 2,
        installConfigId: "cfg_revision",
        installConfigDigest: "sha256:config",
        sourceDefaultRef: "main",
        sourceDefaultPath: ".",
      },
    },
  };
}

async function seedPostgres(client: PGliteSqlClient, id: string): Promise<void> {
  const value = workspace(id);
  await client.query(
    `insert into takosumi_workspaces
      (id, handle, space_json, created_at, updated_at, management_state, management_epoch)
     values ($1, $2, $3::jsonb, $4, $5, 'active', 1)`,
    [value.id, value.handle, JSON.stringify(value), value.createdAt, value.updatedAt],
  );
}

async function seedD1(db: SqliteFakeD1, id: string): Promise<void> {
  const value = workspace(id);
  await db
    .prepare(
      `insert into workspaces
        (id, handle, record_json, created_at, updated_at, management_state, management_epoch)
       values (?, ?, ?, ?, ?, 'active', 1)`,
    )
    .bind(value.id, value.handle, JSON.stringify(value), value.createdAt, value.updatedAt)
    .run();
}

async function expectWorkspaceScoped(label: string, store: GitInstallPlanStore): Promise<void> {
  expect((await store.create(revisionPlan("rp_scope", "ws_one", "cap_scope"))).status, label)
    .toBe("created");
  expect(await store.hasInFlightRevisionForCapsule("cap_scope", "ws_one"), label).toBe(true);
  // The same Capsule id under another Workspace's predicate is not this row.
  expect(await store.hasInFlightRevisionForCapsule("cap_scope", "ws_two"), label).toBe(false);
  expect(await store.hasInFlightRevisionForCapsule("cap_other", "ws_one"), label).toBe(false);
}

test("the in-flight revision check is scoped to the Capsule's Workspace in every store", async () => {
  const postgres = await PGliteSqlClient.create();
  const d1 = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(d1);
  const memoryControl = new InMemoryOpenTofuControlStore();
  for (const id of ["ws_one", "ws_two"]) {
    await memoryControl.putWorkspace(workspace(id));
    await seedPostgres(postgres, id);
    await seedD1(d1, id);
  }
  try {
    await expectWorkspaceScoped("memory", new InMemoryGitInstallPlanStore(memoryControl));
    await expectWorkspaceScoped("postgres", new SqlGitInstallPlanStore(postgres));
    await expectWorkspaceScoped("d1", new D1GitInstallPlanStore(d1));
  } finally {
    await postgres.close();
  }
});

/**
 * An install coordinator row that already created its Capsule: attempt mode
 * as `POST /install-plans` stores it now, or a legacy row without `mode` and
 * `operation`.
 */
function installPlan(
  id: string,
  workspaceId: string,
  capsuleId: string,
  phase: StoredGitInstallPlan["phase"],
  kind: "attempt" | "legacy" = "attempt",
): StoredGitInstallPlan {
  return {
    id,
    workspaceId,
    workspaceManagementAuthority: { workspaceId, managementState: "active", managementEpoch: 1 },
    createdBy: "user_one",
    actorSubject: "user_one",
    idempotencyKeyHash: `key_${id}`,
    requestDigest: `digest_${id}`,
    source: { name: "repo", url: "https://github.com/takos/example.git", ref: "main", path: "." },
    capsule: { name: "example", environment: "production" },
    options: {},
    phase,
    generation: 0,
    createdAt: NOW,
    updatedAt: NOW,
    sourceId: "src_install",
    installConfigId: "cfg_install",
    capsuleId,
    creationAttempted: true,
    ...(kind === "attempt"
      ? {
          operation: "install" as const,
          mode: "attempt" as const,
          // Expiry applies only before the Capsule exists; a bound attempt
          // past it still owns the Capsule.
          expiresAt: "2026-10-26T00:00:00.000Z",
          ...(phase === "awaiting_input" ? { awaitingInput: "inputs" as const } : {}),
        }
      : {}),
  };
}

const OPEN_INSTALL_PHASES = [
  "awaiting_input",
  "creating_capsule",
  "planning",
] as const satisfies readonly StoredGitInstallPlan["phase"][];
const SETTLED_PHASES = [
  "failed",
  "reviewable",
  "discarded",
] as const satisfies readonly StoredGitInstallPlan["phase"][];

async function expectCoordinatorParity(label: string, store: GitInstallPlanStore): Promise<void> {
  const rows = [
    ...OPEN_INSTALL_PHASES.map((phase) =>
      installPlan(`ip_${phase}`, "ws_one", `cap_install_${phase}`, phase)
    ),
    ...SETTLED_PHASES.map((phase) =>
      installPlan(`ip_${phase}`, "ws_one", `cap_install_${phase}`, phase)
    ),
    installPlan("ip_legacy_planning", "ws_one", "cap_legacy_planning", "planning", "legacy"),
    installPlan("ip_legacy_failed", "ws_one", "cap_legacy_failed", "failed", "legacy"),
    // A row that already created its Plan Run but was never reconciled past
    // `planning` (closed tab, timed-out client, legacy authority): the Run
    // now says what is happening, so the row no longer holds the Capsule.
    { ...installPlan("ip_planned", "ws_one", "cap_planned", "planning"), planRunId: "plan_created" },
    { ...installPlan("ip_legacy_planned", "ws_one", "cap_legacy_planned", "planning", "legacy"), planRunId: "plan_legacy" },
    { ...revisionPlan("rp_planned", "ws_one", "cap_revision_planned"), phase: "planning" as const, planRunId: "plan_revision" },
    revisionPlan("rp_open", "ws_one", "cap_revision_open"),
    { ...revisionPlan("rp_reviewable", "ws_one", "cap_revision_reviewable"), phase: "reviewable" as const },
    { ...revisionPlan("rp_failed", "ws_one", "cap_revision_failed"), phase: "failed" as const },
    installPlan("ip_foreign", "ws_two", "cap_foreign", "planning"),
    // Two open rows for one Capsule: the newest is reported.
    installPlan("ip_older", "ws_one", "cap_two_rows", "creating_capsule"),
    { ...installPlan("ip_newer", "ws_one", "cap_two_rows", "awaiting_input"), updatedAt: "2026-10-27T00:05:00.000Z" },
  ];
  for (const row of rows) {
    expect((await store.create(row)).status, `${label} ${row.id}`).toBe("created");
  }
  const preparing = (capsuleId: string, workspaceId = "ws_one", includeInstall = true) =>
    store.preparingCoordinatorForCapsule(capsuleId, workspaceId, { includeInstall });

  // Open install rows without a Plan Run hold a never-applied Capsule in
  // every non-terminal phase, including an attempt idling for input.
  for (const phase of OPEN_INSTALL_PHASES) {
    expect(await preparing(`cap_install_${phase}`), `${label} ${phase}`)
      .toEqual({ id: `ip_${phase}`, operation: "install", updatedAt: NOW });
  }
  expect((await preparing("cap_legacy_planning"))?.id, label).toBe("ip_legacy_planning");
  // An applied Capsule is never held by an install row.
  for (const phase of OPEN_INSTALL_PHASES) {
    expect(await preparing(`cap_install_${phase}`, "ws_one", false), `${label} applied ${phase}`)
      .toBeUndefined();
  }
  // Terminal rows release it.
  for (const phase of SETTLED_PHASES) {
    expect(await preparing(`cap_install_${phase}`), `${label} ${phase}`).toBeUndefined();
  }
  expect(await preparing("cap_legacy_failed"), label).toBeUndefined();
  // Once a Plan Run exists the row is not preparing anything.
  for (const capsuleId of ["cap_planned", "cap_legacy_planned", "cap_revision_planned"]) {
    expect(await preparing(capsuleId), `${label} ${capsuleId}`).toBeUndefined();
  }
  // Revision rows count whether or not the Capsule was applied.
  expect(await preparing("cap_revision_open", "ws_one", false), label)
    .toEqual({ id: "rp_open", operation: "revision", updatedAt: NOW });
  expect(await preparing("cap_revision_reviewable"), label).toBeUndefined();
  expect(await preparing("cap_revision_failed"), label).toBeUndefined();
  // The newest of several open rows is reported.
  expect((await preparing("cap_two_rows"))?.id, label).toBe("ip_newer");
  // Another Workspace's row, or a Capsule without a row, is not this Capsule's.
  expect(await preparing("cap_foreign"), label).toBeUndefined();
  expect((await preparing("cap_foreign", "ws_two"))?.id, label).toBe("ip_foreign");
  expect(await preparing("cap_unbound"), label).toBeUndefined();
  // The revision-only check still ignores install rows.
  expect(await store.hasInFlightRevisionForCapsule("cap_install_planning", "ws_one"), label)
    .toBe(false);
}

test("the preparing coordinator lookup agrees across stores", async () => {
  const postgres = await PGliteSqlClient.create();
  const d1 = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(d1);
  const memoryControl = new InMemoryOpenTofuControlStore();
  for (const id of ["ws_one", "ws_two"]) {
    await memoryControl.putWorkspace(workspace(id));
    await seedPostgres(postgres, id);
    await seedD1(d1, id);
  }
  try {
    await expectCoordinatorParity("memory", new InMemoryGitInstallPlanStore(memoryControl));
    await expectCoordinatorParity("postgres", new SqlGitInstallPlanStore(postgres));
    await expectCoordinatorParity("d1", new D1GitInstallPlanStore(d1));
  } finally {
    await postgres.close();
  }
});

test("the D1 coordinator checks bind the Workspace predicate they filter on", async () => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          statements.push({ sql, values });
          return this;
        },
        first: async () => null,
        run: async () => ({ results: [], success: true, meta: {} }),
      };
    },
  };
  const store = new D1GitInstallPlanStore(db as never);
  expect(await store.hasInFlightRevisionForCapsule("cap_scope", "ws_one")).toBe(false);
  expect(await store.preparingCoordinatorForCapsule("cap_scope", "ws_one", { includeInstall: true })).toBeUndefined();
  expect(statements).toHaveLength(2);
  for (const statement of statements) expect(statement.sql).toContain("where workspace_id = ?");
  expect(statements[0]!.values).toEqual(["ws_one", "cap_scope"]);
  expect(statements[1]!.values).toEqual(["ws_one", "cap_scope", 1]);
});
