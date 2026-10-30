import { afterEach, expect, test } from "bun:test";
import type { Capsule } from "takosumi-contract/capsules";
import type { Workspace } from "takosumi-contract/workspaces";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import {
  applyCapsuleScopeRefBackfill,
  d1CapsuleScopeRefBackfillTarget,
  planCapsuleScopeRefBackfill,
  sqlCapsuleScopeRefBackfillTarget,
  type CapsuleScopeRefBackfillTarget,
} from "../../../../core/domains/capsules/scope_ref_backfill.ts";
import { runCapsuleScopeRefBackfill } from "../../../../scripts/backfill-capsule-scope-ref.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { storedCapsuleArtifactRoot } from "../../../../worker/src/stored-capsule-root.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const NOW = "2026-10-30T00:00:00.000Z";
const WS = "ws_scope_parity";
const clients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly {
  readonly name: string;
  readonly control: OpenTofuControlStore;
  readonly backfill?: CapsuleScopeRefBackfillTarget;
  /** Writes the physical root as the ownership backfill would. */
  readonly persistStorageRoot: (capsuleId: string, root: string) => Promise<void>;
}[]> {
  const memory = new InMemoryOpenTofuControlStore();
  const pg = await PGliteSqlClient.create();
  clients.push(pg);
  const postgres = new SqlOpenTofuControlStore({ client: pg });
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const d1 = new CloudflareD1OpenTofuControlStore(db);
  return [
    {
      name: "memory",
      control: memory,
      persistStorageRoot: async (capsuleId, storageRoot) => {
        expect(memory.setCapsuleOwnership({
          capsuleId,
          ownerAccountId: "tsub_scope_owner",
          ownershipEpoch: 0,
          managementState: "active",
          managementEpoch: 0,
          storageRoot,
        })).toBe(true);
      },
    },
    {
      name: "postgres",
      control: postgres,
      backfill: sqlCapsuleScopeRefBackfillTarget(pg),
      persistStorageRoot: async (capsuleId, storageRoot) => {
        await pg.query(`update takosumi_capsules set storage_root=$2 where id=$1`, [capsuleId, storageRoot]);
      },
    },
    {
      name: "d1",
      control: d1,
      backfill: d1CapsuleScopeRefBackfillTarget(db),
      persistStorageRoot: async (capsuleId, storageRoot) => {
        await db.prepare(`update capsules set storage_root=? where id=?`).bind(storageRoot, capsuleId).run();
      },
    },
  ];
}

function workspace(): Workspace {
  return {
    id: WS,
    handle: "scope-parity",
    displayName: "Scope parity",
    type: "personal",
    ownerUserId: "tsub_scope_owner",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function capsule(id: string, extra: Partial<Capsule> = {}): Capsule {
  return {
    id,
    workspaceId: WS,
    projectId: `prj_default_${WS}`,
    name: id.replaceAll("_", "-"),
    slug: id.replaceAll("_", "-"),
    sourceId: "src_scope_parity",
    installConfigId: `cfg_${id}`,
    environment: "production",
    currentStateGeneration: 0,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

async function seedSource(control: OpenTofuControlStore): Promise<void> {
  await control.putWorkspace(workspace());
  await control.putSource({
    id: "src_scope_parity",
    workspaceId: WS,
    name: "scope-parity",
    url: "https://example.com/scope.git",
    defaultRef: "main",
    defaultPath: ".",
    status: "active",
    hookSecretHash: "fixture-hash",
    autoSync: false,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function initialAuthority(app: Capsule) {
  return {
    installConfig: {
      id: app.installConfigId,
      workspaceId: WS,
      name: app.name,
      variableMapping: {},
      outputAllowlist: {},
      policy: {},
      createdAt: NOW,
      updatedAt: NOW,
    },
    capsule: app,
    initialOwnership: {
      capsuleId: app.id,
      ownerAccountId: "tsub_scope_owner",
      ownershipEpoch: 0,
      managementState: "active" as const,
      managementEpoch: 0,
      storageRoot: `apps/${app.id}`,
    },
    providerBindingSet: {
      id: `pbs_${app.id}`,
      workspaceId: WS,
      capsuleId: app.id,
      environment: app.environment,
      bindings: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

test("a Capsule created before stage 9.0 replays under stage 9.0 code in every store", async () => {
  for (const { name, control } of await stores()) {
    await seedSource(control);
    const legacy = { ...capsule("cap_replay"), status: "pending" as const };
    // Written by pre-9.0 code: no scopeRef.
    expect((await control.createCapsuleInitialAuthority(initialAuthority(legacy))).status, name).toBe("created");
    // Replayed by 9.0 code, which writes scopeRef = Workspace id.
    expect(
      (await control.createCapsuleInitialAuthority(initialAuthority({ ...legacy, scopeRef: WS }))).status,
      name,
    ).toBe("replayed");
    // A different scope is a different Capsule and stays a conflict.
    expect(
      (await control.createCapsuleInitialAuthority(initialAuthority({ ...legacy, scopeRef: "ws_other" }))).status,
      name,
    ).toBe("conflict");
    // The stored row is untouched by the replay.
    expect((await control.getCapsule("cap_replay"))?.scopeRef, name).toBeUndefined();
  }
});

test("scopeRef round-trips through every store unchanged", async () => {
  for (const { name, control } of await stores()) {
    await seedSource(control);
    await control.putCapsule(capsule("cap_frozen", { scopeRef: "ws_frozen_scope" }));
    const stored = await control.getCapsule("cap_frozen");
    expect(stored?.scopeRef, name).toBe("ws_frozen_scope");
    expect(stored?.workspaceId, name).toBe(WS);
    expect((await control.listCapsules()).find((row) => row.id === "cap_frozen")?.scopeRef, name).toBe("ws_frozen_scope");
  }
});

test("the backfill freezes every unfrozen row once, including destroyed rows, in Postgres and D1", async () => {
  for (const { name, control, backfill } of await stores()) {
    if (!backfill) continue;
    await seedSource(control);
    await control.putCapsule(capsule("cap_a_live"));
    await control.putCapsule(capsule("cap_b_destroyed", { status: "destroyed" }));
    await control.putCapsule(capsule("cap_c_frozen", { scopeRef: WS }));
    await control.putCapsule(capsule("cap_d_diverged", { scopeRef: "ws_moved_scope" }));
    const before = await control.getCapsule("cap_a_live");

    const plan = await planCapsuleScopeRefBackfill(backfill);
    expect(plan, name).toMatchObject({
      total: 4,
      byStatus: { active: 3, destroyed: 1 },
      writes: [
        { capsuleId: "cap_a_live", scopeRef: WS },
        { capsuleId: "cap_b_destroyed", scopeRef: WS },
      ],
      alreadyFrozen: 1,
      diverged: ["cap_d_diverged"],
      refused: [],
    });
    expect(plan.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    // The CLI dry-run writes nothing.
    const dryRun = await runCapsuleScopeRefBackfill(backfill, {});
    expect(dryRun, name).toMatchObject({ mode: "dry-run", writes: 2, writeIds: ["cap_a_live", "cap_b_destroyed"], digest: plan.digest });
    expect((await control.getCapsule("cap_a_live"))?.scopeRef, name).toBeUndefined();
    await expect(runCapsuleScopeRefBackfill(backfill, { apply: true })).rejects.toThrow("--plan-digest");
    await expect(applyCapsuleScopeRefBackfill(backfill, `sha256:${"0".repeat(64)}`)).rejects.toThrow("plan changed");

    expect(await applyCapsuleScopeRefBackfill(backfill, plan.digest), name).toEqual({
      frozen: 2,
      skipped: [],
      remaining: 0,
    });
    // Only scopeRef was added; every other field is byte-identical.
    const after = await control.getCapsule("cap_a_live");
    expect(after, name).toEqual({ ...before!, scopeRef: WS });
    expect((await control.getCapsule("cap_b_destroyed"))?.scopeRef, name).toBe(WS);
    expect((await control.getCapsule("cap_c_frozen"))?.scopeRef, name).toBe(WS);
    expect((await control.getCapsule("cap_d_diverged"))?.scopeRef, name).toBe("ws_moved_scope");

    // Re-running is a no-op, and a row frozen meanwhile is never overwritten.
    const rerun = await planCapsuleScopeRefBackfill(backfill);
    expect(rerun.writes, name).toEqual([]);
    expect(await backfill.freeze("cap_a_live", WS), name).toBe(false);
    expect(await backfill.freeze("cap_d_diverged", WS), name).toBe(false);
  }
});

test("the backfill refuses a row whose column and record disagree", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const control = new CloudflareD1OpenTofuControlStore(db);
  await seedSource(control);
  await control.putCapsule(capsule("cap_skewed"));
  await db.prepare(
    `update capsules set record_json = json_set(record_json, '$.workspaceId', 'ws_elsewhere') where id = ?`,
  ).bind("cap_skewed").run();
  const target = d1CapsuleScopeRefBackfillTarget(db);
  const plan = await planCapsuleScopeRefBackfill(target);
  expect(plan.writes).toEqual([]);
  expect(plan.refused).toEqual([{ capsuleId: "cap_skewed", reason: "workspace_column_mismatch" }]);
  expect(await target.freeze("cap_skewed", WS)).toBe(false);
});

test("a row without a persisted root reads its legacy root from scopeRef in every store", async () => {
  for (const { name, control } of await stores()) {
    await seedSource(control);
    // Pre-9.0 row: no scopeRef, so the root is the Workspace id's.
    await control.putCapsule(capsule("cap_root_legacy"));
    expect(await control.getCapsuleStorageRoot("cap_root_legacy"), name)
      .toBe(`workspaces/${WS}/capsules/cap_root_legacy`);
    // The authority Workspace moved after scopeRef was frozen: the legacy root
    // stays where it was written.
    await control.putCapsule(capsule("cap_root_moved", { scopeRef: "ws_frozen_root" }));
    expect(await control.getCapsuleStorageRoot("cap_root_moved"), name)
      .toBe("workspaces/ws_frozen_root/capsules/cap_root_moved");
    expect(await control.getCapsuleStorageRoot("cap_absent"), name).toBeUndefined();
  }
});

test("a malformed scopeRef fails the storage root the same way in every store", async () => {
  for (const { name, control, persistStorageRoot } of await stores()) {
    await seedSource(control);
    for (const [suffix, scopeRef] of [
      ["number", 7],
      ["boolean", true],
      ["null", null],
      ["empty", ""],
      ["object", { id: WS }],
    ] as const) {
      const id = `cap_malformed_${suffix}`;
      await control.putCapsule(capsule(id, { scopeRef: scopeRef as unknown as string }));
      await expect(control.getCapsuleStorageRoot(id), `${name}:${suffix}`).rejects.toThrow("Capsule scopeRef is invalid");
      // A persisted root does not depend on scopeRef at all.
      await persistStorageRoot(id, `apps/${id}`);
      expect(await control.getCapsuleStorageRoot(id), `${name}:${suffix}`).toBe(`apps/${id}`);
    }
  }
});

test("a persisted legacy root keeps allocating after the Workspace id moves, in every store", async () => {
  const allocator = new ObjectKeyArtifactReferenceAllocator();
  for (const { name, control, persistStorageRoot } of await stores()) {
    await seedSource(control);
    // Written under ws_before, frozen in storage_root; the Capsule's authority
    // Workspace is now WS and its scopeRef the original Workspace id.
    await control.putCapsule(capsule("cap_root_persisted", { scopeRef: "ws_before" }));
    await persistStorageRoot("cap_root_persisted", "workspaces/ws_before/capsules/cap_root_persisted");
    const root = await control.getCapsuleStorageRoot("cap_root_persisted");
    expect(root, name).toBe("workspaces/ws_before/capsules/cap_root_persisted");
    // Apply, restore and raw-output allocation name the live Workspace and
    // must follow the persisted root instead of refusing it.
    expect(allocator.allocate({
      kind: "state",
      workspaceId: WS,
      subject: { kind: "capsule", id: "cap_root_persisted" },
      environment: "production",
      generation: 2,
      storageRoot: root,
    }), name).toBe("workspaces/ws_before/capsules/cap_root_persisted/environments/production/state-versions/00000002.tfstate.enc");
    expect(allocator.allocate({
      kind: "raw_output",
      workspaceId: WS,
      subject: { kind: "capsule", id: "cap_root_persisted" },
      runId: "apply_2",
      storageRoot: root,
    }), name).toBe("workspaces/ws_before/capsules/cap_root_persisted/runs/apply_2/outputs.raw.json.enc");
  }
});

test("the D1 stored-service root reader follows the persisted root, else scopeRef", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const control = new CloudflareD1OpenTofuControlStore(db);
  await seedSource(control);
  await control.putCapsule(capsule("cap_usage_scope", { scopeRef: "ws_frozen_usage" }));
  expect(await storedCapsuleArtifactRoot(db, WS, "cap_usage_scope"))
    .toBe("workspaces/ws_frozen_usage/capsules/cap_usage_scope");
  await db.prepare(`update capsules set storage_root=? where id=?`)
    .bind("workspaces/ws_before/capsules/cap_usage_scope", "cap_usage_scope").run();
  expect(await storedCapsuleArtifactRoot(db, WS, "cap_usage_scope"))
    .toBe("workspaces/ws_before/capsules/cap_usage_scope");
  // Still an exact Capsule identity, never a free-form path.
  await db.prepare(`update capsules set storage_root=? where id=?`)
    .bind("workspaces/ws_before/capsules/cap_other", "cap_usage_scope").run();
  await expect(storedCapsuleArtifactRoot(db, WS, "cap_usage_scope")).rejects.toThrow();
});

test("the backfill reports a row without a Workspace column instead of planning a write it cannot apply", async () => {
  const frozen: string[] = [];
  const target: CapsuleScopeRefBackfillTarget = {
    async listRows() {
      return [
        { id: "cap_no_column", status: "active", columnWorkspaceId: null, recordWorkspaceId: WS, recordScopeRef: null },
        { id: "cap_ok", status: "active", columnWorkspaceId: WS, recordWorkspaceId: WS, recordScopeRef: null },
      ];
    },
    async freeze(capsuleId) {
      frozen.push(capsuleId);
      return true;
    },
  };
  const plan = await planCapsuleScopeRefBackfill(target);
  expect(plan.writes).toEqual([{ capsuleId: "cap_ok", scopeRef: WS }]);
  expect(plan.refused).toEqual([{ capsuleId: "cap_no_column", reason: "workspace_column_missing" }]);
  await applyCapsuleScopeRefBackfill(target, plan.digest);
  expect(frozen).toEqual(["cap_ok"]);
});
