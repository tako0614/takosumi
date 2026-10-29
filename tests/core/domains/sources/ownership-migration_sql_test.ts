import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { deterministicInitialCapsuleId, deterministicInstallSourceId } from "../../../../core/domains/install-plans/source-reservation.ts";
import type { Capsule } from "takosumi-contract/capsules";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import type { StoredGitInstallPlan } from "../../../../core/domains/install-plans/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import type { StoredSource } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { inventorySourceOwnershipGroup, migrateSourceOwnership, prepareSourceOwnershipMigration } from "../../../../core/domains/sources/ownership-migration.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";

setDefaultTimeout(30_000);
const NOW = "2026-10-28T00:00:00.000Z";
const clients: PGliteSqlClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

async function fixture(capsuleIds: readonly string[]) {
  const client = await PGliteSqlClient.create();
  clients.push(client);
  const store = new SqlOpenTofuControlStore({ client });
  const workspace = { id: "ws_migrate", handle: "ws-migrate", displayName: "Migration",
    type: "personal", ownerUserId: "owner_migrate", createdAt: NOW, updatedAt: NOW };
  await client.query(
    `insert into takosumi_workspaces (id, handle, space_json, created_at, updated_at)
     values ($1, $2, $3::jsonb, $4, $5)`,
    [workspace.id, workspace.handle, JSON.stringify(workspace), NOW, NOW],
  );
  const source: StoredSource = { id: "src_shared", workspaceId: workspace.id, name: "shared",
    url: "https://example.test/repo.git", defaultRef: "main", defaultPath: ".",
    status: "active", autoSync: true, hookSecretHash: "a".repeat(64),
    createdAt: NOW, updatedAt: NOW };
  await client.query(
    `insert into takosumi_sources (id, space_id, status, source_json, created_at, updated_at)
     values ($1, $2, $3, $4::jsonb, $5, $6)`,
    [source.id, source.workspaceId, source.status, JSON.stringify(source), NOW, NOW],
  );
  for (const id of capsuleIds) {
    const capsule: Capsule = { id, workspaceId: workspace.id, projectId: "prj_migrate",
      name: id, slug: id, sourceId: source.id, installConfigId: `cfg_${id}`,
      environment: "production", currentStateGeneration: 0, status: "active",
      createdAt: NOW, updatedAt: NOW };
    await client.query(
      `insert into takosumi_capsules
        (id, space_id, project_id, name, environment, source_id, install_config_id,
         status, installation_json, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
      [id, capsule.workspaceId, capsule.projectId, capsule.name, capsule.environment,
        capsule.sourceId, capsule.installConfigId, capsule.status,
        JSON.stringify(capsule), NOW, NOW],
    );
    const config: InstallConfig = { id: capsule.installConfigId,
      workspaceId: workspace.id, name: id, variableMapping: {},
      outputAllowlist: {}, policy: {}, createdAt: NOW, updatedAt: NOW };
    await client.query(
      `insert into takosumi_install_configs
        (id, space_id, config_json, created_at, updated_at)
       values ($1, $2, $3::jsonb, $4, $5)`,
      [config.id, config.workspaceId, JSON.stringify(config), NOW, NOW],
    );
  }
  return { client, store, source };
}

test("Postgres migration inventories Capsule InstallConfigs", async () => {
  const { store, source } = await fixture(["cap_a", "cap_b"]);
  const group = (await store.readGroup(source.id))!;
  expect((Reflect.get(group, "installConfigs") as readonly InstallConfig[] | undefined)?.map((config) => config.id))
    .toEqual(["cfg_cap_a", "cfg_cap_b"]);
});

test("Postgres Source split commits Source, Capsule and Activity atomically", async () => {
  const { client, store } = await fixture(["cap_a", "cap_b"]);
  const allocator = new ObjectKeyArtifactReferenceAllocator();
  const dry = await migrateSourceOwnership(store, allocator, { copyVerified: async () => {} });
  expect(dry).toHaveLength(1);
  expect(dry[0]?.inventory.action).toBe("split");
  expect(dry[0]?.status).toBe("dry_run");
  const applied = await migrateSourceOwnership(store, allocator, { copyVerified: async () => {} },
    { apply: true, now: NOW });
  expect(applied[0]?.status).toBe("committed");
  const sources = await store.listSources();
  expect(sources).toHaveLength(2);
  expect(sources.map((source) => source.ownerCapsuleId).sort()).toEqual(["cap_a", "cap_b"]);
  const moved = sources.find((source) => source.ownerCapsuleId === "cap_b")!;
  expect((await store.getCapsule("cap_b"))?.sourceId).toBe(moved.id);
  expect((await store.readGroup(moved.id))?.capsules.map(({ capsule }) => capsule.id)).toEqual(["cap_b"]);
  const events = await client.query<{ action: string }>(
    `select action from takosumi_audit_events where target_id = $1`, [moved.id]);
  expect(events.rows.map((row) => row.action)).toEqual(["source.split"]);
  expect((await migrateSourceOwnership(store, allocator, { copyVerified: async () => {} }))[0]?.status)
    .toBe("unchanged");
});

test("Postgres Source migration rejects changed group before any write", async () => {
  const { client, store } = await fixture(["cap_a", "cap_b"]);
  const group = (await store.readGroup("src_shared"))!;
  const mutation = (await prepareSourceOwnershipMigration(
    group, new ObjectKeyArtifactReferenceAllocator(), NOW))!;
  await client.query(`update takosumi_capsules set status = 'disabled',
    installation_json = installation_json || '{"status":"disabled"}'::jsonb where id = 'cap_b'`);
  expect(await store.commitGroup(mutation)).toBe("conflict");
  expect(await store.listSources()).toHaveLength(1);
  const events = await client.query(`select id from takosumi_audit_events where action = 'source.split'`);
  expect(events.rows).toHaveLength(0);
});

test("Postgres migration conflicts on a private InstallConfig change after inventory", async () => {
  const { client, store, source } = await fixture(["cap_a", "cap_b"]);
  const authority = { workspaceId: source.workspaceId, managementState: "active",
    managementEpoch: 1 };
  await client.query(
    `update takosumi_install_configs
        set config_json = config_json || jsonb_build_object('workspaceManagementAuthority', $2::jsonb)
      where id = $1`, ["cfg_cap_b", JSON.stringify(authority)],
  );
  const dry = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => {} });
  expect(JSON.stringify(dry)).not.toContain("workspaceManagementAuthority");
  const group = (await store.readGroup(source.id))!;
  const mutation = (await prepareSourceOwnershipMigration(
    group, new ObjectKeyArtifactReferenceAllocator(), NOW))!;
  await client.query(
    `update takosumi_install_configs
        set config_json = jsonb_set(config_json, '{workspaceManagementAuthority,managementEpoch}', '2'::jsonb)
      where id = $1`, ["cfg_cap_b"],
  );
  expect(await store.commitGroup(mutation)).toBe("conflict");
  expect((await store.getSource(source.id))?.ownerCapsuleId).toBeUndefined();
  expect((await store.getCapsule("cap_b"))?.sourceId).toBe(source.id);
});

test("Postgres Source split collision rolls back the retained Source update", async () => {
  const { client, store, source } = await fixture(["cap_a", "cap_b"]);
  const mutation = (await prepareSourceOwnershipMigration(
    (await store.readGroup(source.id))!, new ObjectKeyArtifactReferenceAllocator(), NOW))!;
  const colliding = { ...source, id: mutation.splits[0]!.source.id };
  await client.query(
    `insert into takosumi_sources (id, space_id, status, source_json, created_at, updated_at)
     values ($1, $2, $3, $4::jsonb, $5, $6)`,
    [colliding.id, colliding.workspaceId, colliding.status, JSON.stringify(colliding), NOW, NOW],
  );
  expect(await store.commitGroup(mutation)).toBe("conflict");
  expect((await store.getSource(source.id))?.ownerCapsuleId).toBeUndefined();
  expect((await store.getCapsule("cap_b"))?.sourceId).toBe(source.id);
});

test("Postgres split rewrites snapshot, sync, PlanRun, report and GitInstallPlan references", async () => {
  const { client, store, source } = await fixture(["cap_a", "cap_b"]);
  const snapshot: SourceSnapshot = { id: "snap_shared", origin: "git",
    workspaceId: source.workspaceId, sourceId: source.id, url: source.url,
    ref: "main", path: ".", resolvedCommit: "abc123",
    archiveRef: `workspaces/${source.workspaceId}/sources/${source.id}/snapshots/snap_shared/source.tar.zst`,
    archiveDigest: "sha256:abc", archiveSizeBytes: 42,
    fetchedByRunId: "sync_shared", fetchedAt: NOW };
  const sync: SourceSyncRun = { id: "sync_shared", kind: "source_sync",
    workspaceId: source.workspaceId, sourceId: source.id, url: source.url,
    ref: "main", path: ".", archiveRef: snapshot.archiveRef,
    status: "succeeded", snapshotId: snapshot.id, createdAt: NOW, updatedAt: NOW };
  await client.query(
    `insert into takosumi_runs
      (id, kind, space_id, source_id, status, created_at, run_json)
     values ($1, 'source_sync', $2, $3, $4, $5, $6::jsonb)`,
    [sync.id, sync.workspaceId, sync.sourceId, sync.status, sync.createdAt, JSON.stringify(sync)],
  );
  await client.query(
    `insert into takosumi_source_snapshots (id, source_id, snapshot_json, fetched_at)
     values ($1, $2, $3::jsonb, $4)`,
    [snapshot.id, snapshot.sourceId, JSON.stringify(snapshot), snapshot.fetchedAt],
  );
  const currentConfig = { id: "cfg_cap_b", workspaceId: source.workspaceId,
    name: "cap_b", variableMapping: {}, outputAllowlist: {}, policy: {},
    internal: { reason: "per_install_overrides", sourceSnapshotId: snapshot.id },
    workspaceManagementAuthority: { workspaceId: source.workspaceId,
      managementState: "active", managementEpoch: 1 },
    createdAt: NOW, updatedAt: NOW };
  await client.query(
    `update takosumi_install_configs set config_json = $2::jsonb where id = $1`,
    [currentConfig.id, JSON.stringify(currentConfig)],
  );
  const report: CapsuleCompatibilityReport = { id: "report_shared", sourceId: source.id,
    sourceSnapshotId: snapshot.id, level: "ready", findings: [], providerPackages: [],
    rootProviderRequirements: [], resources: [], dataSources: [], provisioners: [], createdAt: NOW };
  await store.putCapsuleCompatibilityReport(report);
  const capsuleReport: CapsuleCompatibilityReport = {
    ...report, id: "report_capsule_b", capsuleId: "cap_b",
  };
  await store.putCapsuleCompatibilityReport(capsuleReport);
  const compatibilityRun = { id: "check_shared", workspaceId: source.workspaceId,
    sourceId: source.id, sourceSnapshotId: snapshot.id,
    compatibilityReportId: report.id, type: "compatibility_check",
    status: "succeeded", createdAt: NOW };
  await client.query(
    `insert into takosumi_runs
      (id, kind, space_id, source_id, status, created_at, run_json)
     values ($1, 'compatibility_check', $2, $3, $4, $5, $6::jsonb)`,
    [compatibilityRun.id, compatibilityRun.workspaceId, compatibilityRun.sourceId,
      compatibilityRun.status, compatibilityRun.createdAt, JSON.stringify(compatibilityRun)],
  );
  const capsuleCheckRun = { ...compatibilityRun, id: "check_capsule_b",
    capsuleId: "cap_b", compatibilityReportId: capsuleReport.id };
  await client.query(
    `insert into takosumi_runs
      (id, kind, space_id, source_id, installation_id, status, created_at, run_json)
     values ($1, 'compatibility_check', $2, $3, $4, $5, $6, $7::jsonb)`,
    [capsuleCheckRun.id, capsuleCheckRun.workspaceId, capsuleCheckRun.sourceId,
      capsuleCheckRun.capsuleId, capsuleCheckRun.status,
      capsuleCheckRun.createdAt, JSON.stringify(capsuleCheckRun)],
  );
  const plan = { id: "plan_b", workspaceId: source.workspaceId, capsuleId: "cap_b",
    source: { kind: "git", url: source.url, ref: "main", commit: "abc123" },
    sourceSnapshotId: snapshot.id, compatibilityReportId: report.id,
    status: "succeeded", createdAt: 1, updatedAt: 1 };
  await client.query(
    `insert into takosumi_runs
      (id, kind, space_id, installation_id, status, created_at, run_json)
     values ($1, 'plan', $2, $3, $4, $5, $6::jsonb)`,
    [plan.id, plan.workspaceId, plan.capsuleId, plan.status, String(plan.createdAt), JSON.stringify(plan)],
  );
  const gitPlan = { id: "git_plan_b", workspaceId: source.workspaceId,
    actorSubject: "owner", idempotencyKeyHash: "hash", requestDigest: "digest",
    phase: "reviewable", generation: 1, capsuleId: "cap_b", sourceId: source.id,
    sourceSnapshotId: snapshot.id, sourceSyncRunId: sync.id,
    compatibilityReportId: report.id, compatibilityCheckRunId: capsuleCheckRun.id,
    preflight: { sourceId: source.id, sourceSnapshotId: snapshot.id,
      compatibilityCheckRunId: compatibilityRun.id, compatibilityReportId: report.id,
      installConfigId: currentConfig.id },
    createdAt: NOW, updatedAt: NOW } as unknown as StoredGitInstallPlan;
  await client.query(
    `insert into takosumi_git_install_plans
      (id, workspace_id, actor_subject, idempotency_key_hash, request_digest,
       phase, generation, record_json, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
    [gitPlan.id, gitPlan.workspaceId, gitPlan.actorSubject, gitPlan.idempotencyKeyHash,
      gitPlan.requestDigest, gitPlan.phase, gitPlan.generation, JSON.stringify(gitPlan), NOW, NOW],
  );
  const original = (await store.readGroup(source.id))!;
  expect(original.syncRuns.map((run) => run.id)).toEqual([sync.id]);
  expect(original.compatibilityRuns.map((run) => run.id)).toEqual([capsuleCheckRun.id, compatibilityRun.id]);
  expect(original.installConfigs.map((config) => config.id)).toEqual(["cfg_cap_a", "cfg_cap_b"]);
  expect(original.planRuns.map((run) => run.id)).toEqual([plan.id]);
  expect(original.gitPlans.map((run) => run.id)).toEqual([gitPlan.id]);
  const result = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => {} }, { apply: true, now: NOW });
  expect(result[0]?.status).toBe("committed");
  const moved = (await store.listSources()).find((item) => item.ownerCapsuleId === "cap_b")!;
  const group = (await store.readGroup(moved.id))!;
  const copiedPreflightReport = group.reports.find((item) => item.capsuleId === undefined)!;
  const copiedPreflightRun = group.compatibilityRuns.find((item) => item.capsuleId === undefined)!;
  const copiedCapsuleRun = group.compatibilityRuns.find((item) => item.capsuleId === "cap_b")!;
  expect(group.snapshots).toHaveLength(1);
  expect(group.syncRuns).toHaveLength(1);
  expect(group.compatibilityRuns).toHaveLength(2);
  expect(group.snapshots[0]?.fetchedByRunId).toBe(group.syncRuns[0]?.id);
  expect(group.snapshots[0]?.archiveRef).toContain(`/sources/${moved.id}/`);
  expect(group.planRuns[0]?.sourceSnapshotId).toBe(group.snapshots[0]?.id);
  expect(copiedPreflightReport.sourceSnapshotId).toBe(group.snapshots[0]?.id);
  expect(group.gitPlans[0]?.sourceSnapshotId).toBe(group.snapshots[0]?.id);
  expect(group.gitPlans[0]?.sourceSyncRunId).toBe(group.syncRuns[0]?.id);
  expect(group.gitPlans[0]?.compatibilityReportId).toBe(copiedPreflightReport.id);
  expect(group.gitPlans[0]?.compatibilityCheckRunId).toBe(copiedCapsuleRun.id);
  expect(group.gitPlans[0]?.preflight?.compatibilityCheckRunId).toBe(copiedPreflightRun.id);
  expect(copiedPreflightRun.sourceSnapshotId).toBe(group.snapshots[0]?.id);
  expect(copiedPreflightRun.compatibilityReportId).toBe(copiedPreflightReport.id);
  expect((await store.getCapsuleCompatibilityReport(capsuleReport.id))?.capsuleId).toBeUndefined();
  expect((await store.getCompatibilityCheckRun(capsuleCheckRun.id))?.capsuleId).toBeUndefined();
  const movedCapsule = (await store.getCapsule("cap_b"))!;
  expect(movedCapsule.installConfigId).not.toBe(currentConfig.id);
  const movedConfig = (await store.getInstallConfig(movedCapsule.installConfigId))!;
  expect(movedConfig.internal?.sourceSnapshotId).toBe(group.snapshots[0]?.id);
  expect((await store.getSourceSnapshot(movedConfig.internal!.sourceSnapshotId!))?.sourceId).toBe(moved.id);
  const rawConfig = await client.query<{ configJson: { workspaceManagementAuthority?: unknown } }>(
    `select config_json as "configJson" from takosumi_install_configs where id = $1`,
    [movedConfig.id],
  );
  expect(rawConfig.rows[0]?.configJson.workspaceManagementAuthority)
    .toEqual(currentConfig.workspaceManagementAuthority);
  const dry = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => {} });
  expect(dry.map((item) => [item.inventory.sourceId, item.status]).sort())
    .toEqual([[moved.id, "unchanged"], [source.id, "unchanged"]].sort());
});

test("Postgres split carries standalone Capsule compatibility evidence without a GitInstallPlan", async () => {
  const { client, store, source } = await fixture(["cap_a", "cap_b"]);
  const sync: SourceSyncRun = { id: "sync_standalone", kind: "source_sync",
    workspaceId: source.workspaceId, sourceId: source.id, url: source.url,
    ref: "main", path: ".", archiveRef: "archive_standalone",
    status: "succeeded", snapshotId: "snap_standalone", createdAt: NOW, updatedAt: NOW };
  const snapshot: SourceSnapshot = { id: sync.snapshotId!, origin: "git",
    workspaceId: source.workspaceId, sourceId: source.id, url: source.url,
    ref: "main", path: ".", resolvedCommit: "abc123", archiveRef: sync.archiveRef,
    archiveDigest: "sha256:abc", archiveSizeBytes: 42,
    fetchedByRunId: sync.id, fetchedAt: NOW };
  await client.query(
    `insert into takosumi_runs (id, kind, space_id, source_id, status, created_at, run_json)
     values ($1, 'source_sync', $2, $3, $4, $5, $6::jsonb)`,
    [sync.id, sync.workspaceId, sync.sourceId, sync.status, sync.createdAt, JSON.stringify(sync)],
  );
  await client.query(
    `insert into takosumi_source_snapshots (id, source_id, snapshot_json, fetched_at)
     values ($1, $2, $3::jsonb, $4)`,
    [snapshot.id, snapshot.sourceId, JSON.stringify(snapshot), snapshot.fetchedAt],
  );
  const report: CapsuleCompatibilityReport = { id: "report_standalone",
    sourceId: source.id, capsuleId: "cap_b", sourceSnapshotId: snapshot.id,
    level: "ready", findings: [], providerPackages: [], rootProviderRequirements: [],
    resources: [], dataSources: [], provisioners: [], createdAt: NOW };
  await store.putCapsuleCompatibilityReport(report);
  const check = { id: "check_standalone", workspaceId: source.workspaceId,
    sourceId: source.id, capsuleId: "cap_b", sourceSnapshotId: snapshot.id,
    compatibilityReportId: report.id, type: "compatibility_check",
    status: "succeeded", createdAt: NOW };
  await client.query(
    `insert into takosumi_runs
      (id, kind, space_id, source_id, installation_id, status, created_at, run_json)
     values ($1, 'compatibility_check', $2, $3, $4, $5, $6, $7::jsonb)`,
    [check.id, check.workspaceId, check.sourceId, check.capsuleId,
      check.status, check.createdAt, JSON.stringify(check)],
  );
  expect((await store.readGroup(source.id))?.gitPlans).toEqual([]);
  const applied = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => {} }, { apply: true, now: NOW });
  expect(applied[0]?.status).toBe("committed");
  const moved = (await store.listSources()).find((item) => item.ownerCapsuleId === "cap_b")!;
  const movedGroup = (await store.readGroup(moved.id))!;
  expect(movedGroup.compatibilityRuns).toHaveLength(1);
  expect(movedGroup.reports).toHaveLength(1);
  expect(movedGroup.compatibilityRuns[0]?.capsuleId).toBe("cap_b");
  expect(movedGroup.reports[0]?.capsuleId).toBe("cap_b");
  expect(movedGroup.compatibilityRuns[0]?.sourceSnapshotId).toBe(movedGroup.snapshots[0]?.id);
  expect(movedGroup.compatibilityRuns[0]?.compatibilityReportId).toBe(movedGroup.reports[0]?.id);
  expect((await store.getCompatibilityCheckRun(check.id))?.capsuleId).toBeUndefined();
  expect((await store.getCapsuleCompatibilityReport(report.id))?.capsuleId).toBeUndefined();
  const dry = await migrateSourceOwnership(store, new ObjectKeyArtifactReferenceAllocator(),
    { copyVerified: async () => {} });
  expect(dry.map((item) => [item.inventory.sourceId, item.status]).sort())
    .toEqual([[moved.id, "unchanged"], [source.id, "unchanged"]].sort());
});

test("Postgres SourceSync admission rejects disabled and retiring Sources but replays exact rows", async () => {
  const { client, store, source } = await fixture([]);
  const sync: SourceSyncRun = { id: "sync_before_retire", kind: "source_sync",
    workspaceId: source.workspaceId, sourceId: source.id, url: source.url,
    ref: "main", path: ".", archiveRef: "archive",
    status: "queued", createdAt: NOW, updatedAt: NOW };
  const authority = { workspaceId: source.workspaceId, managementState: "active" as const,
    managementEpoch: 1 };
  expect((await store.beginSourceSyncRun(sync, authority)).status).toBe("created");
  const disabled = { ...source, status: "disabled" as const, autoSync: false,
    retiringAt: NOW };
  await client.query(
    `update takosumi_sources set status = $2, source_json = $3::jsonb
      where id = $1`, [source.id, disabled.status, JSON.stringify(disabled)],
  );
  expect((await store.beginSourceSyncRun(sync, authority)).status).toBe("existing");
  expect((await store.beginSourceSyncRun({ ...sync, id: "sync_after_retire" }, authority)).status)
    .toBe("conflict");
  const retiring = { ...source, retiringAt: NOW };
  await client.query(
    `update takosumi_sources set status = $2, source_json = $3::jsonb
      where id = $1`, [source.id, retiring.status, JSON.stringify(retiring)],
  );
  expect((await store.beginSourceSyncRun({ ...sync, id: "sync_retiring" }, authority)).status)
    .toBe("conflict");
});

test("Postgres migration rejects grouped source-scoped Runs before copying", async () => {
  const { client, store, source } = await fixture(["cap_a", "cap_b"]);
  const base = { id: "sync_grouped", kind: "source_sync", workspaceId: source.workspaceId,
    sourceId: source.id, url: source.url, ref: "main", path: ".",
    archiveRef: "archive", status: "succeeded", runGroupId: "group_1",
    createdAt: NOW, updatedAt: NOW };
  await client.query(
    `insert into takosumi_runs
      (id, kind, space_id, source_id, status, created_at, run_json)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [base.id, base.kind, base.workspaceId, base.sourceId, base.status,
      base.createdAt, JSON.stringify(base)],
  );
  await expect(store.readGroup(source.id)).rejects.toThrow("grouped_source_run:sync_grouped");
  await client.query(`delete from takosumi_runs where id = $1`, [base.id]);
  const check = { id: "check_grouped", type: "compatibility_check",
    workspaceId: source.workspaceId, sourceId: source.id, status: "succeeded",
    runGroupId: "group_2", createdAt: NOW };
  await client.query(
    `insert into takosumi_runs
      (id, kind, space_id, source_id, status, created_at, run_json)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [check.id, check.type, check.workspaceId, check.sourceId, check.status,
      check.createdAt, JSON.stringify(check)],
  );
  await expect(store.readGroup(source.id)).rejects.toThrow("grouped_source_run:check_grouped");
});

test("Postgres inventory hydrates a lost-ack creator and blocks active or recent terminal plans", async () => {
  const { store, source, client } = await fixture([]);
  const now = "2026-10-30T00:00:00.000Z";
  const planId = "git_lost_ack_pg";
  const reservedId = deterministicInstallSourceId(planId);
  await store.putSource({ ...source, id: reservedId,
    ownerCapsuleId: deterministicInitialCapsuleId(planId), createdByInstallPlanId: planId });
  const creator = { id: planId, workspaceId: source.workspaceId, actorSubject: "user_one",
    idempotencyKeyHash: "lost_ack", requestDigest: "lost_ack", phase: "awaiting_input", mode: "attempt",
    generation: 0, expiresAt: "2026-10-31T00:00:00.000Z", createdAt: NOW, updatedAt: NOW } as StoredGitInstallPlan;
  await client.query(`insert into takosumi_git_install_plans
    (id, workspace_id, actor_subject, idempotency_key_hash, request_digest, phase, generation, record_json, created_at, updated_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
    [planId, source.workspaceId, creator.actorSubject, creator.idempotencyKeyHash, creator.requestDigest,
      creator.phase, creator.generation, JSON.stringify(creator), NOW, NOW]);
  let group = (await store.readGroup(reservedId))!;
  expect(group.gitPlans.map((plan) => plan.id)).toEqual([planId]);
  expect(inventorySourceOwnershipGroup(group, now).action).toBe("blocked");
  const recent = { ...creator, phase: "discarded", completedAt: now };
  await client.query("update takosumi_git_install_plans set phase = $1, record_json = $2::jsonb where id = $3",
    [recent.phase, JSON.stringify(recent), planId]);
  group = (await store.readGroup(reservedId))!;
  expect(inventorySourceOwnershipGroup(group, now)).toMatchObject({ action: "blocked", reason: "source_creator_plan_still_active" });
});
