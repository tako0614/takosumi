import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Capsule, InstallConfig } from "takosumi-contract/install-configs";
import type { ProviderBindingSet } from "takosumi-contract/connections";
import type { Workspace } from "takosumi-contract/workspaces";
import type {
  SqlClient, SqlParameters, SqlQueryResult, SqlTransaction,
} from "../../../../core/adapters/storage/sql.ts";
import {
  InMemoryOpenTofuControlStore,
  SourceOwnershipConflictError,
  type CapsuleInitialAuthorityInput,
  type OpenTofuControlStore,
  type StoredSource,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

setDefaultTimeout(30_000);

const WORKSPACE = "workspace_source_owner";
const SOURCE = "src_source_owner";
const NOW = "2026-10-28T00:00:00.000Z";
const LATER = "2026-10-28T00:00:01.000Z";
const clients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function stores(): Promise<readonly [string, OpenTofuControlStore][]> {
  const pg = await PGliteSqlClient.create();
  clients.push(pg);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client: pg })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

function workspace(): Workspace {
  return {
    id: WORKSPACE, handle: "source-owner", displayName: "Source owner",
    type: "personal", ownerUserId: "owner_source_owner",
    createdAt: NOW, updatedAt: NOW,
  };
}

function source(ownerCapsuleId?: string, id = SOURCE): StoredSource {
  return {
    id, workspaceId: WORKSPACE, name: "source-owner",
    url: "https://example.com/acme/repo.git", defaultRef: "main", defaultPath: ".",
    status: "active", hookSecretHash: "hash", autoSync: true,
    createdAt: NOW, updatedAt: NOW,
    ...(ownerCapsuleId ? { ownerCapsuleId } : {}),
  };
}

function authority(capsuleId: string, sourceId = SOURCE): CapsuleInitialAuthorityInput {
  const config: InstallConfig = {
    id: `config_${capsuleId}`, workspaceId: WORKSPACE, name: capsuleId,
    variableMapping: {}, outputAllowlist: {}, policy: {},
    createdAt: NOW, updatedAt: NOW,
  };
  const capsule: Capsule = {
    id: capsuleId, workspaceId: WORKSPACE, projectId: "project_source_owner",
    name: capsuleId, slug: capsuleId, sourceId, installConfigId: config.id,
    installingPrincipalId: "principal_source_owner", environment: "production",
    currentStateGeneration: 0, status: "pending", createdAt: NOW, updatedAt: NOW,
  };
  const providerBindingSet: ProviderBindingSet = {
    id: `binding_${capsuleId}`, workspaceId: WORKSPACE, capsuleId,
    environment: "production", bindings: [], createdAt: NOW, updatedAt: NOW,
  };
  return { installConfig: config, capsule, providerBindingSet };
}

class FailBindingInsertSqlClient implements SqlClient {
  constructor(private readonly base: SqlClient) {}

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string, parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    return this.base.query<Row>(query, parameters);
  }

  transaction<T>(fn: (transaction: SqlTransaction) => T | Promise<T>): Promise<T> {
    return this.base.transaction((transaction) => fn({
      query: <Row extends Record<string, unknown> = Record<string, unknown>>(
        query: string, parameters?: SqlParameters,
      ): Promise<SqlQueryResult<Row>> => {
        if (/insert into\s+"?takosumi_provider_env_binding_sets/iu.test(query)) {
          throw new Error("injected binding insert failure");
        }
        return transaction.query<Row>(query, parameters);
      },
      transaction: transaction.transaction.bind(transaction),
    }));
  }
}

class FailFinalBatchD1 extends SqliteFakeD1 {
  failNextBatch = false;
  beforeNextBatch?: () => Promise<void>;

  override async batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> {
    const before = this.beforeNextBatch;
    this.beforeNextBatch = undefined;
    await before?.();
    if (!this.failNextBatch) return await super.batch<T>(statements);
    this.failNextBatch = false;
    return await super.batch<T>([
      ...statements,
      this.prepare(`insert into sources (id, space_id, status, record_json, created_at, updated_at)
        values ('injected_bad_source', null, null, null, null, null)`),
    ]);
  }
}

test("initial authority atomically claims an unowned Source and replays the matching owner", async () => {
  for (const [label, store] of await stores()) {
    await store.putWorkspace(workspace());
    await store.putSource(source());
    const input = authority(`cap_claim_${label}`);
    expect((await store.createCapsuleInitialAuthority(input)).status, label).toBe("created");
    expect((await store.getSource(SOURCE))?.ownerCapsuleId, label).toBe(input.capsule.id);
    expect((await store.createCapsuleInitialAuthority(input)).status, label).toBe("replayed");
    expect((await store.getSource(SOURCE))?.ownerCapsuleId, label).toBe(input.capsule.id);

    const preownedId = `${SOURCE}_preowned`;
    const preownedCapsuleId = `cap_preowned_${label}`;
    await store.putSource(source(preownedCapsuleId, preownedId));
    expect((await store.createCapsuleInitialAuthority(
      authority(preownedCapsuleId, preownedId),
    )).status, label).toBe("created");
  }
});

test("new initial authority refuses disabled or retiring Sources without partial writes", async () => {
  for (const [label, store] of await stores()) {
    await store.putWorkspace(workspace());
    for (const [index, state] of [
      { status: "disabled" as const },
      { status: "disabled" as const, retiringAt: NOW },
      { status: "active" as const, retiringAt: NOW },
    ].entries()) {
      for (const preowned of [false, true]) {
        const capsuleId = `cap_fenced_${label}_${index}_${preowned}`;
        const sourceId = `${SOURCE}_${index}_${preowned}`;
        await store.putSource({ ...source(preowned ? capsuleId : undefined, sourceId), ...state });
        const input = authority(capsuleId, sourceId);
        expect(await store.createCapsuleInitialAuthority(input), label).toEqual({ status: "conflict" });
        expect(await store.getCapsule(capsuleId), label).toBeUndefined();
        expect(await store.getInstallConfig(input.installConfig.id), label).toBeUndefined();
        expect(await store.getProviderBindingSetByCapsule(capsuleId, "production"), label).toBeUndefined();
        expect((await store.getSource(sourceId))?.ownerCapsuleId, label)
          .toBe(preowned ? capsuleId : undefined);
      }
    }
  }
});

test("exact initial authority replay survives later conflicting references and Source deletion", async () => {
  for (const [label, store] of await stores()) {
    await store.putWorkspace(workspace());
    await store.putSource(source());
    const original = authority(`cap_original_${label}`);
    expect((await store.createCapsuleInitialAuthority(original)).status, label).toBe("created");
    const later = authority(`cap_later_reference_${label}`);
    await store.putCapsule({ ...later.capsule, status: "destroyed" });
    expect((await store.createCapsuleInitialAuthority(original)).status, label).toBe("replayed");
    expect(await store.deleteSource(SOURCE), label).toBe(true);
    expect((await store.createCapsuleInitialAuthority(original)).status, label).toBe("replayed");
    expect(await store.getSource(SOURCE), label).toBeUndefined();
  }
});

test("a foreign Workspace Capsule reference cannot block a rightful Source claim", async () => {
  for (const [label, store] of await stores()) {
    await store.putWorkspace(workspace());
    const foreignWorkspaceId = `${WORKSPACE}_foreign`;
    await store.putWorkspace({ ...workspace(), id: foreignWorkspaceId,
      handle: "source-owner-foreign", ownerUserId: "owner_source_owner_foreign" });
    await store.putSource(source());
    const foreign = authority(`cap_foreign_tenant_${label}`);
    await store.putCapsule({ ...foreign.capsule, workspaceId: foreignWorkspaceId,
      status: "destroyed" });
    const rightful = authority(`cap_rightful_${label}`);
    expect((await store.createCapsuleInitialAuthority(rightful)).status, label).toBe("created");
    expect((await store.getSource(SOURCE))?.ownerCapsuleId, label).toBe(rightful.capsule.id);
  }
});

test("another owner or any other Capsule reference refuses initial authority without partial writes", async () => {
  for (const [label, store] of await stores()) {
    await store.putWorkspace(workspace());
    const target = authority(`cap_target_${label}`);
    await store.putSource(source(`cap_other_${label}`));
    expect(await store.createCapsuleInitialAuthority(target), label)
      .toEqual({ status: "source_owned_by_another_app" });
    expect(await store.getInstallConfig(target.installConfig.id), label).toBeUndefined();
    expect(await store.getCapsule(target.capsule.id), label).toBeUndefined();
    expect(await store.getProviderBindingSetByCapsule(target.capsule.id, "production"), label).toBeUndefined();

    // A destroyed Capsule remains a Source reference. It cannot be ignored to
    // let a later App silently take authority over that Source.
    const unownedSourceId = `${SOURCE}_referenced`;
    await store.putSource(source(undefined, unownedSourceId));
    const other = authority(`cap_other_reference_${label}`, unownedSourceId);
    await store.putCapsule({ ...other.capsule, status: "destroyed" });
    const later = authority(`cap_after_destroy_${label}`, unownedSourceId);
    expect(await store.createCapsuleInitialAuthority(later), label)
      .toEqual({ status: "source_owned_by_another_app" });
    expect((await store.getSource(unownedSourceId))?.ownerCapsuleId, label).toBeUndefined();
    expect(await store.getInstallConfig(later.installConfig.id), label).toBeUndefined();

    const preownedId = `${SOURCE}_preowned_referenced`;
    const targetOwnerId = `cap_owner_referenced_${label}`;
    await store.putSource(source(targetOwnerId, preownedId));
    await store.putCapsule({
      ...authority(`cap_foreign_reference_${label}`, preownedId).capsule,
      status: "destroyed",
    });
    expect(await store.createCapsuleInitialAuthority(
      authority(targetOwnerId, preownedId),
    ), label).toEqual({ status: "source_owned_by_another_app" });
  }
});

test("owner cannot be removed or changed by direct Source upsert or configuration CAS", async () => {
  for (const [label, store] of await stores()) {
    await store.putWorkspace(workspace());
    const owned = source(`cap_owner_${label}`);
    await store.putSource(owned);
    await expect(store.putSource({ ...owned, ownerCapsuleId: `cap_foreign_${label}` }), label)
      .rejects.toBeInstanceOf(SourceOwnershipConflictError);
    await expect(store.putSource({ ...owned, ownerCapsuleId: undefined }), label)
      .rejects.toBeInstanceOf(SourceOwnershipConflictError);
    await expect(store.putSource({ ...owned, workspaceId: `${WORKSPACE}_foreign` }), label)
      .rejects.toBeInstanceOf(SourceOwnershipConflictError);
    const candidate = { ...owned, updatedAt: LATER, ownerCapsuleId: `cap_foreign_${label}` };
    expect(await store.writeSourceConfiguration({ source: candidate, expectedSource: owned }), label)
      .toEqual({ status: "conflict" });
    expect((await store.getSource(SOURCE))?.ownerCapsuleId, label).toBe(owned.ownerCapsuleId);

    const unownedId = `${SOURCE}_unowned`;
    const unowned = source(undefined, unownedId);
    await store.putSource(unowned);
    await expect(store.putSource({ ...unowned, ownerCapsuleId: `cap_claim_bypass_${label}` }), label)
      .rejects.toBeInstanceOf(SourceOwnershipConflictError);
    expect(await store.writeSourceConfiguration({
      source: { ...unowned, ownerCapsuleId: `cap_claim_bypass_${label}`, updatedAt: LATER },
      expectedSource: unowned,
    }), label).toEqual({ status: "conflict" });
    expect((await store.getSource(unownedId))?.ownerCapsuleId, label).toBeUndefined();

    const createdId = `${SOURCE}_created`;
    const created = {
      ...source(`cap_created_${label}`, createdId),
      createdByInstallPlanId: `install_plan_${label}`,
    };
    await store.putSource(created);
    await expect(store.putSource({ ...created, createdByInstallPlanId: undefined }), label)
      .rejects.toBeInstanceOf(SourceOwnershipConflictError);
    expect(await store.writeSourceConfiguration({
      source: { ...created, createdByInstallPlanId: `other_plan_${label}`, updatedAt: LATER },
      expectedSource: created,
    }), label).toEqual({ status: "conflict" });
    expect((await store.getSource(createdId))?.createdByInstallPlanId, label)
      .toBe(created.createdByInstallPlanId);
  }
});

test("competing Capsule claims have exactly one Source owner", async () => {
  // PGlite uses one SQL client, so its Promise concurrency is serialized by
  // that connection; this proves the transaction result, not server-session overlap.
  for (const [label, store] of await stores()) {
    await store.putWorkspace(workspace());
    await store.putSource(source());
    const left = authority(`cap_left_${label}`);
    const right = authority(`cap_right_${label}`);
    const results = await Promise.all([
      store.createCapsuleInitialAuthority(left),
      store.createCapsuleInitialAuthority(right),
    ]);
    expect(results.map((result) => result.status).sort(), label)
      .toEqual(["created", "source_owned_by_another_app"]);
    const owner = (await store.getSource(SOURCE))?.ownerCapsuleId;
    expect([left.capsule.id, right.capsule.id], label).toContain(owner);
    const loser = owner === left.capsule.id ? right : left;
    expect(await store.getInstallConfig(loser.installConfig.id), label).toBeUndefined();
    expect(await store.getCapsule(loser.capsule.id), label).toBeUndefined();
  }
});

test("Postgres and D1 roll back the Source claim with the entire initial unit on a late write failure", async () => {
  const pg = await PGliteSqlClient.create();
  clients.push(pg);
  const d1 = new FailFinalBatchD1();
  const cases: readonly [string, OpenTofuControlStore, () => void][] = [
    ["postgres", new SqlOpenTofuControlStore({ client: new FailBindingInsertSqlClient(pg) }), () => {}],
    ["d1", new CloudflareD1OpenTofuControlStore(d1), () => { d1.failNextBatch = true; }],
  ];
  for (const [label, store, arm] of cases) {
    await store.putWorkspace(workspace());
    await store.putSource(source());
    const input = authority(`cap_rollback_${label}`);
    arm();
    await expect(store.createCapsuleInitialAuthority(input), label).rejects.toThrow();
    expect((await store.getSource(SOURCE))?.ownerCapsuleId, label).toBeUndefined();
    expect(await store.getInstallConfig(input.installConfig.id), label).toBeUndefined();
    expect(await store.getCapsule(input.capsule.id), label).toBeUndefined();
    expect(await store.getProviderBindingSetByCapsule(input.capsule.id, "production"), label).toBeUndefined();
  }
});

test("D1 classifies a Source deleted between its read and atomic claim as conflict", async () => {
  const db = new FailFinalBatchD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  await store.putWorkspace(workspace());
  await store.putSource(source());
  const input = authority("cap_deleted_before_claim");
  db.beforeNextBatch = async () => {
    expect(await store.deleteSource(SOURCE)).toBe(true);
  };
  expect(await store.createCapsuleInitialAuthority(input)).toEqual({ status: "conflict" });
  expect(await store.getSource(SOURCE)).toBeUndefined();
  expect(await store.getInstallConfig(input.installConfig.id)).toBeUndefined();
  expect(await store.getCapsule(input.capsule.id)).toBeUndefined();
  expect(await store.getProviderBindingSetByCapsule(input.capsule.id, "production")).toBeUndefined();
});
