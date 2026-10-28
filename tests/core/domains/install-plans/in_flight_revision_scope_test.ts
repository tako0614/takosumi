import { expect, test } from "bun:test";
import { D1GitInstallPlanStore } from "../../../../core/domains/install-plans/d1_store.ts";
import { SqlGitInstallPlanStore } from "../../../../core/domains/install-plans/sql_store.ts";
import {
  activeGitRevisionPreparation,
  GIT_REVISION_PREPARATION_STALL_AFTER_MS,
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
function revisionPlan(
  id: string,
  workspaceId: string,
  capsuleId: string,
  baseGeneration = 2,
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
        capsuleStateGeneration: baseGeneration,
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

/** The Capsule the fixtures' revision rows were pinned to (generation 2). */
function capsuleAt(id: string, workspaceId = "ws_one", currentStateGeneration = 2) {
  return { id, workspaceId, currentStateGeneration };
}

async function expectWorkspaceScoped(label: string, store: GitInstallPlanStore): Promise<void> {
  expect((await store.create(revisionPlan("rp_scope", "ws_one", "cap_scope"))).status, label)
    .toBe("created");
  const now = Date.parse(NOW);
  expect((await activeGitRevisionPreparation(store, capsuleAt("cap_scope"), now))?.id, label)
    .toBe("rp_scope");
  // The same Capsule id under another Workspace's predicate is not this row.
  expect(await activeGitRevisionPreparation(store, capsuleAt("cap_scope", "ws_two"), now), label)
    .toBeUndefined();
  expect(await activeGitRevisionPreparation(store, capsuleAt("cap_other"), now), label)
    .toBeUndefined();
}

test("the active revision lookup is scoped to the Capsule's Workspace in every store", async () => {
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

async function expectCoordinatorParity(
  label: string,
  store: GitInstallPlanStore,
  /** Rewrites a row's stored JSON (rows the stores no longer create). */
  retainLegacy?: (plan: StoredGitInstallPlan) => Promise<void>,
): Promise<void> {
  const rows = [
    ...OPEN_INSTALL_PHASES.map((phase) =>
      installPlan(`ip_${phase}`, "ws_one", `cap_install_${phase}`, phase)
    ),
    ...SETTLED_PHASES.map((phase) =>
      installPlan(`ip_${phase}`, "ws_one", `cap_install_${phase}`, phase)
    ),
    installPlan("ip_legacy_planning", "ws_one", "cap_legacy_planning", "planning", "legacy"),
    installPlan("ip_authority_planning", "ws_one", "cap_authority_planning", "planning", "legacy"),
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
    // A newer revision row pinned to an older generation does not hide an
    // older row pinned to the current one.
    { ...revisionPlan("rp_moved_base", "ws_one", "cap_revision_bases", 1), updatedAt: "2026-10-27T00:05:00.000Z" },
    revisionPlan("rp_current_base", "ws_one", "cap_revision_bases"),
    revisionPlan("rp_null_authority", "ws_one", "cap_revision_null_authority"),
  ];
  for (const row of rows) {
    expect((await store.create(row)).status, `${label} ${row.id}`).toBe("created");
  }
  if (retainLegacy) {
    // Written before management authority persisted: absent, or JSON null.
    const { workspaceManagementAuthority: _authority, ...legacy } =
      rows.find((row) => row.id === "ip_legacy_planning")!;
    await retainLegacy(legacy as StoredGitInstallPlan);
    await retainLegacy({
      ...rows.find((row) => row.id === "rp_null_authority")!,
      workspaceManagementAuthority: null,
    } as unknown as StoredGitInstallPlan);
  }
  const preparing = (
    capsuleId: string,
    workspaceId = "ws_one",
    includeInstall = true,
    currentStateGeneration = 2,
  ) =>
    store.preparingCoordinatorForCapsule(capsuleId, workspaceId, {
      includeInstall,
      currentStateGeneration,
    });

  // Open install rows without a Plan Run hold a never-applied Capsule in
  // every non-terminal phase, including an attempt idling for input.
  for (const phase of OPEN_INSTALL_PHASES) {
    expect(await preparing(`cap_install_${phase}`), `${label} ${phase}`).toEqual({
      id: `ip_${phase}`,
      operation: "install",
      phase,
      actorSubject: "user_one",
      updatedAt: NOW,
    });
  }
  // A row written before management-authority persistence can never be
  // reconciled again, so it is not preparing anything. (Only the durable
  // stores can hold such historical rows.)
  if (retainLegacy) expect(await preparing("cap_legacy_planning"), label).toBeUndefined();
  expect((await preparing("cap_authority_planning"))?.id, label).toBe("ip_authority_planning");
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
  // Revision rows count whether or not the Capsule was applied, while
  // their base is the current state generation.
  expect(await preparing("cap_revision_open", "ws_one", false), label)
    .toEqual({ id: "rp_open", operation: "revision", phase: "syncing_source", actorSubject: "user_one", updatedAt: NOW });
  expect(await preparing("cap_revision_open", "ws_one", false, 3), `${label} moved base`)
    .toBeUndefined();
  expect((await preparing("cap_revision_bases", "ws_one", false))?.id, label).toBe("rp_current_base");
  expect((await preparing("cap_revision_bases", "ws_one", false, 1))?.id, label).toBe("rp_moved_base");
  // JSON null authority reads as absent in every durable store.
  if (retainLegacy) {
    expect(await preparing("cap_revision_null_authority", "ws_one", false), `${label} null authority`)
      .toBeUndefined();
  }
  expect(await preparing("cap_revision_reviewable"), label).toBeUndefined();
  expect(await preparing("cap_revision_failed"), label).toBeUndefined();
  // The newest of several open rows is reported.
  expect((await preparing("cap_two_rows"))?.id, label).toBe("ip_newer");
  // Another Workspace's row, or a Capsule without a row, is not this Capsule's.
  expect(await preparing("cap_foreign"), label).toBeUndefined();
  expect((await preparing("cap_foreign", "ws_two"))?.id, label).toBe("ip_foreign");
  expect(await preparing("cap_unbound"), label).toBeUndefined();

  // The active revision (the one definition the app view, a second revision
  // and configuration changes share) adds only "still moving".
  const now = Date.parse(NOW);
  const active = async (capsuleId: string, at = now, currentStateGeneration = 2) =>
    (await activeGitRevisionPreparation(store, capsuleAt(capsuleId, "ws_one", currentStateGeneration), at))?.id;
  expect(await active("cap_revision_open"), label).toBe("rp_open");
  expect(await active("cap_revision_open", now + GIT_REVISION_PREPARATION_STALL_AFTER_MS - 1), label)
    .toBe("rp_open");
  expect(await active("cap_revision_open", now + GIT_REVISION_PREPARATION_STALL_AFTER_MS), `${label} stalled`)
    .toBeUndefined();
  expect(await active("cap_revision_open", now, 3), `${label} moved base`).toBeUndefined();
  for (const capsuleId of [
    "cap_revision_planned",
    "cap_revision_reviewable",
    "cap_revision_failed",
    // Install rows never hold version or configuration changes.
    "cap_install_planning",
    "cap_install_awaiting_input",
  ]) {
    expect(await active(capsuleId), `${label} ${capsuleId}`).toBeUndefined();
  }
  if (retainLegacy) expect(await active("cap_revision_null_authority"), label).toBeUndefined();
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
    await expectCoordinatorParity("postgres", new SqlGitInstallPlanStore(postgres), async (value) => {
      await postgres.query(
        "update takosumi_git_install_plans set record_json = $1::jsonb where id = $2",
        [JSON.stringify(value), value.id],
      );
    });
    await expectCoordinatorParity("d1", new D1GitInstallPlanStore(d1), async (value) => {
      await d1.prepare("update git_install_plans set record_json = ? where id = ?")
        .bind(JSON.stringify(value), value.id).run();
    });
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
  expect(
    await store.preparingCoordinatorForCapsule("cap_scope", "ws_one", {
      includeInstall: true,
      currentStateGeneration: 4,
    }),
  ).toBeUndefined();
  expect(statements).toHaveLength(1);
  expect(statements[0]!.sql).toContain("where workspace_id = ?");
  expect(statements[0]!.values).toEqual(["ws_one", "cap_scope", 4, 1]);
});
