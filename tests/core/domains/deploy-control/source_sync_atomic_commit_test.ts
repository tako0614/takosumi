import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type {
  SourceSnapshot,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type { Capsule } from "takosumi-contract/capsules";
import type { StateVersion } from "takosumi-contract/state-versions";
import type { Workspace } from "takosumi-contract/workspaces";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
  SqlTransaction,
} from "../../../../core/adapters/storage/sql.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

setDefaultTimeout(30_000);

const CREATED_AT = "2026-08-27T00:00:00.000Z";
const STARTED_AT = "2026-08-27T00:00:01.000Z";
const FINISHED_AT = "2026-08-27T00:00:02.000Z";
const RUN_ID = "ssr_atomic_1";
const SNAPSHOT_ID = "snap_atomic_1";
const SOURCE_ID = "src_atomic_1";
const WORKSPACE_ID = "workspace_atomic_1";
const ARCHIVE_REF =
  "workspaces/workspace_atomic_1/sources/src_atomic_1/snapshots/snap_atomic_1/source.tar.zst";

const pgClients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

function queuedRun(): SourceSyncRun {
  return {
    id: RUN_ID,
    kind: "source_sync",
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    url: "https://example.com/acme/app.git",
    ref: "main",
    path: ".",
    archiveRef: ARCHIVE_REF,
    intent: "observe",
    status: "queued",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    snapshotId: SNAPSHOT_ID,
  };
}

function succeededRun(
  running: SourceSyncRun,
  resolvedCommit: string,
): SourceSyncRun {
  return {
    ...running,
    status: "succeeded",
    heartbeatAt: 2_000,
    finishedAt: FINISHED_AT,
    updatedAt: FINISHED_AT,
    resolvedCommit,
    archiveDigest: `sha256:${resolvedCommit}`,
    archiveSizeBytes: 4_096,
    snapshotId: SNAPSHOT_ID,
  };
}

function sourceSnapshot(
  resolvedCommit: string,
  overrides: Partial<SourceSnapshot> = {},
): SourceSnapshot {
  return {
    id: SNAPSHOT_ID,
    origin: "git",
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    url: "https://example.com/acme/app.git",
    ref: "main",
    resolvedCommit,
    path: ".",
    archiveRef: ARCHIVE_REF,
    archiveDigest: `sha256:${resolvedCommit}`,
    archiveSizeBytes: 4_096,
    repositoryInstallMetadata: { status: "absent" },
    repositoryManifest: { status: "absent" },
    repositoryModules: { status: "ready", scopePath: ".", modules: [] },
    fetchedByRunId: RUN_ID,
    fetchedAt: FINISHED_AT,
    ...overrides,
  };
}

function workspace(): Workspace {
  return {
    id: WORKSPACE_ID,
    handle: "workspace-atomic-1",
    displayName: "Workspace Atomic 1",
    type: "personal",
    ownerUserId: "owner_atomic_1",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

async function claimRun(
  store: OpenTofuControlStore,
  leaseToken: string,
  queued: SourceSyncRun = queuedRun(),
): Promise<SourceSyncRun> {
  await store.putWorkspace(workspace());
  await store.beginSourceSyncRun(queued, {
    workspaceId: WORKSPACE_ID,
    managementState: "active",
    managementEpoch: 1,
  });
  const running: SourceSyncRun = {
    ...queued,
    status: "running",
    startedAt: STARTED_AT,
    heartbeatAt: 1_000,
    updatedAt: STARTED_AT,
  };
  const claimed = await store.transitionRun({
    id: queued.id,
    kind: "source_sync",
    expectFrom: ["queued"],
    run: running,
    setLeaseToken: leaseToken,
    heartbeatAt: running.heartbeatAt,
  });
  expect(claimed.won).toBe(true);
  return claimed.run as SourceSyncRun;
}

async function seedAppliedCapsule(input: {
  readonly store: OpenTofuControlStore;
  readonly capsuleId: string;
  readonly snapshotId: string;
  readonly resolvedCommit: string;
  readonly ref?: string;
  readonly path?: string;
}): Promise<Capsule> {
  const previous = sourceSnapshot(input.resolvedCommit, {
    id: input.snapshotId,
    ref: input.ref ?? "main",
    path: input.path ?? ".",
    fetchedByRunId: `previous_${input.capsuleId}`,
    archiveRef: `${ARCHIVE_REF}/${input.snapshotId}`,
  });
  const { capsule } = await seedCapsuleModel(input.store, {
    workspaceId: WORKSPACE_ID,
    sourceId: SOURCE_ID,
    sourceUrl: queuedRun().url,
    ref: "main",
    snapshotId: previous.id,
    capsuleId: input.capsuleId,
    installConfigId: `config_${input.capsuleId}`,
    name: input.capsuleId,
    withoutSnapshot: true,
  });
  await input.store.putSourceSnapshot(previous);

  const planRun: PlanRun = {
    id: `plan_${input.capsuleId}`,
    workspaceId: WORKSPACE_ID,
    capsuleId: capsule.id,
    source: { kind: "git", url: previous.url, commit: previous.resolvedCommit },
    sourceDigest: `sha256:${"a".repeat(64)}`,
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest: `sha256:${"b".repeat(64)}`,
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: `sha256:${"c".repeat(64)}`,
    planDigest: `sha256:${"d".repeat(64)}`,
    sourceSnapshotId: previous.id,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const applyRun: ApplyRun = {
    id: `apply_${input.capsuleId}`,
    planRunId: planRun.id,
    workspaceId: WORKSPACE_ID,
    capsuleId: capsule.id,
    stateVersionId: `state_${input.capsuleId}`,
    operation: "update",
    runnerProfileId: planRun.runnerProfileId,
    status: "succeeded",
    expected: {
      planRunId: planRun.id,
      capsuleId: capsule.id,
      runnerProfileId: planRun.runnerProfileId,
      sourceDigest: planRun.sourceDigest,
      variablesDigest: planRun.variablesDigest,
      policyDecisionDigest: planRun.policyDecisionDigest,
      planDigest: planRun.planDigest!,
      planArtifactDigest: `sha256:${"e".repeat(64)}`,
    },
    stateBackend: { kind: "operator-managed", ref: "state://test" },
    stateLock: { status: "recorded", backendRef: "state://test" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const stateVersion: StateVersion = {
    id: applyRun.stateVersionId!,
    workspaceId: WORKSPACE_ID,
    capsuleId: capsule.id,
    environment: capsule.environment,
    generation: 1,
    stateRef: `state-ref-${input.capsuleId}`,
    digest: `sha256:${"f".repeat(64)}`,
    createdByRunId: applyRun.id,
    createdAt: FINISHED_AT,
  };
  await input.store.putPlanRun(planRun);
  await input.store.putApplyRun(applyRun);
  await input.store.putStateVersion(stateVersion);
  const active: Capsule = {
    ...capsule,
    currentStateVersionId: stateVersion.id,
    currentStateGeneration: stateVersion.generation,
    status: "active",
    updatedAt: FINISHED_AT,
  };
  await input.store.putCapsule(active);
  return active;
}

type SourceSnapshotInterleave = (
  observed: SourceSnapshot | undefined,
) => Promise<void>;

interface InterleavingSettlementStore extends OpenTofuControlStore {
  armAfterSourceSnapshotRead(
    snapshotId: string,
    mutation: SourceSnapshotInterleave,
  ): void;
}

/** Test-only reader seam: return the original observation after a real write. */
class InterleavingMemorySettlementStore
  extends InMemoryOpenTofuControlStore
  implements InterleavingSettlementStore
{
  #interleave?: {
    readonly snapshotId: string;
    readonly mutation: SourceSnapshotInterleave;
  };

  armAfterSourceSnapshotRead(
    snapshotId: string,
    mutation: SourceSnapshotInterleave,
  ): void {
    if (this.#interleave !== undefined) {
      throw new Error("source snapshot interleave is already armed");
    }
    this.#interleave = { snapshotId, mutation };
  }

  override async getSourceSnapshot(
    id: string,
  ): Promise<SourceSnapshot | undefined> {
    const observed = await super.getSourceSnapshot(id);
    const interleave = this.#interleave;
    if (interleave?.snapshotId === id) {
      this.#interleave = undefined;
      await interleave.mutation(observed);
    }
    return observed;
  }
}

/** The same interleaving seam against the real FakeD1-backed store. */
class InterleavingD1SettlementStore
  extends CloudflareD1OpenTofuControlStore
  implements InterleavingSettlementStore
{
  #interleave?: {
    readonly snapshotId: string;
    readonly mutation: SourceSnapshotInterleave;
  };

  armAfterSourceSnapshotRead(
    snapshotId: string,
    mutation: SourceSnapshotInterleave,
  ): void {
    if (this.#interleave !== undefined) {
      throw new Error("source snapshot interleave is already armed");
    }
    this.#interleave = { snapshotId, mutation };
  }

  override async getSourceSnapshot(
    id: string,
  ): Promise<SourceSnapshot | undefined> {
    const observed = await super.getSourceSnapshot(id);
    const interleave = this.#interleave;
    if (interleave?.snapshotId === id) {
      this.#interleave = undefined;
      await interleave.mutation(observed);
    }
    return observed;
  }
}

/** Keep the D1 settlement path below Cloudflare's 100 KB statement ceiling. */
class BoundedSqliteFakeD1 extends SqliteFakeD1 {
  override prepare(query: string) {
    expect(
      new TextEncoder().encode(query).byteLength,
      "D1 statement UTF-8 byte length",
    ).toBeLessThanOrEqual(100_000);
    return super.prepare(query);
  }
}

function settlementStores(): readonly (readonly [
  string,
  InterleavingSettlementStore,
])[] {
  return [
    ["memory", new InterleavingMemorySettlementStore()],
    ["d1", new InterleavingD1SettlementStore(new BoundedSqliteFakeD1())],
  ];
}

interface PreparedAppliedCapsule {
  readonly capsule: Capsule;
  readonly previous: SourceSnapshot;
  readonly planRun: PlanRun;
  readonly applyRun: ApplyRun;
  readonly stateVersion: StateVersion;
}

/** Clone only the applied lineage; ownership rows stay seeded by the fixture. */
async function prepareAppliedCapsule(
  store: OpenTofuControlStore,
  base: Capsule,
  suffix: string,
): Promise<PreparedAppliedCapsule> {
  const capsuleId = `capsule_late_${suffix}`;
  const previous = sourceSnapshot(`old-late-${suffix}`, {
    id: `snapshot_late_${suffix}`,
    fetchedByRunId: `previous_${capsuleId}`,
    archiveRef: `${ARCHIVE_REF}/snapshot_late_${suffix}`,
  });
  const basePlan = await store.getPlanRun(`plan_${base.id}`);
  const baseApply = await store.getApplyRun(`apply_${base.id}`);
  const baseState = await store.getStateVersion(`state_${base.id}`);
  if (!basePlan || !baseApply || !baseState) {
    throw new Error(`missing applied fixture lineage for ${base.id}`);
  }
  const planRun: PlanRun = {
    ...basePlan,
    id: `plan_${capsuleId}`,
    capsuleId,
    source: {
      ...basePlan.source,
      url: previous.url,
      commit: previous.resolvedCommit,
    },
    sourceSnapshotId: previous.id,
  };
  const applyRun: ApplyRun = {
    ...baseApply,
    id: `apply_${capsuleId}`,
    planRunId: planRun.id,
    capsuleId,
    stateVersionId: `state_${capsuleId}`,
    expected: {
      ...baseApply.expected,
      planRunId: planRun.id,
      capsuleId,
    },
  };
  const stateVersion: StateVersion = {
    ...baseState,
    id: applyRun.stateVersionId!,
    capsuleId,
    createdByRunId: applyRun.id,
    stateRef: `state-ref-${capsuleId}`,
  };
  const capsule: Capsule = {
    ...base,
    id: capsuleId,
    name: `${base.name}-${suffix}`,
    slug: `${base.slug}-${suffix}`,
    installConfigId: `${base.installConfigId}-${suffix}`,
    currentStateVersionId: stateVersion.id,
    currentStateGeneration: stateVersion.generation,
    status: "active",
  };
  return { capsule, previous, planRun, applyRun, stateVersion };
}

async function persistAppliedLineage(
  store: OpenTofuControlStore,
  prepared: PreparedAppliedCapsule,
  includeCapsule = true,
): Promise<void> {
  await store.putSourceSnapshot(prepared.previous);
  await store.putPlanRun(prepared.planRun);
  await store.putApplyRun(prepared.applyRun);
  await store.putStateVersion(prepared.stateVersion);
  if (includeCapsule) await store.putCapsule(prepared.capsule);
}

interface SourceSettlementFixture {
  readonly label: string;
  readonly store: InterleavingSettlementStore;
  readonly changed: Capsule;
  readonly differentRef: Capsule;
  readonly sameCommit: Capsule;
  readonly running: SourceSyncRun;
  readonly terminal: SourceSyncRun;
  readonly snapshot: SourceSnapshot;
}

async function seedSourceSettlementFixture(
  label: string,
  store: InterleavingSettlementStore,
): Promise<SourceSettlementFixture> {
  const changed = await seedAppliedCapsule({
    store,
    capsuleId: `capsule_changed_${label}`,
    snapshotId: `snapshot_changed_${label}`,
    resolvedCommit: `old-changed-${label}`,
  });
  const differentRef = await seedAppliedCapsule({
    store,
    capsuleId: `capsule_ref_${label}`,
    snapshotId: `snapshot_ref_${label}`,
    resolvedCommit: `old-ref-${label}`,
    ref: "refs/heads/release/v2",
  });
  const sameCommit = await seedAppliedCapsule({
    store,
    capsuleId: `capsule_same_${label}`,
    snapshotId: `snapshot_same_${label}`,
    resolvedCommit: `new-${label}`,
  });
  const running = await claimRun(store, `lease_settlement_${label}`);
  return {
    label,
    store,
    changed,
    differentRef,
    sameCommit,
    running,
    terminal: succeededRun(running, `new-${label}`),
    snapshot: sourceSnapshot(`new-${label}`),
  };
}

async function assertSettlementRefused(
  fixture: SourceSettlementFixture,
  expectedCapsules: readonly Capsule[],
): Promise<void> {
  const { label, store, running } = fixture;
  expect(await store.getSourceSyncRun(RUN_ID), `${label}: run`).toEqual(running);
  expect(await store.getSourceSnapshot(SNAPSHOT_ID), `${label}: snapshot`).toBeUndefined();
  expect((await store.getSource(SOURCE_ID))?.lastSeenCommit, `${label}: cursor`).toBeUndefined();
  expect(await store.listActivityEvents(WORKSPACE_ID), `${label}: events`).toEqual([]);
  for (const capsule of expectedCapsules) {
    expect(await store.getCapsule(capsule.id), `${label}: capsule ${capsule.id}`).toEqual(capsule);
  }
}

async function assertSettlementCommitted(
  fixture: SourceSettlementFixture,
  staleCapsuleIds: readonly string[],
  expectedCapsules: readonly Capsule[],
): Promise<void> {
  const { label, store, terminal, snapshot } = fixture;
  const committed = await store.commitSourceSyncSuccess({
    terminalRun: terminal,
    leaseToken: `lease_settlement_${label}`,
    snapshot,
  });
  expect(committed.won, `${label}: retry`).toBe(true);
  expect(
    committed.staleCapsules?.map((capsule) => capsule.id).sort(),
    `${label}: retry stale projection`,
  ).toEqual([...staleCapsuleIds].sort());
  expect(await store.getSourceSyncRun(RUN_ID), `${label}: committed run`).toEqual(terminal);
  expect(await store.getSourceSnapshot(SNAPSHOT_ID), `${label}: committed snapshot`).toEqual(snapshot);
  expect((await store.getSource(SOURCE_ID))?.lastSeenCommit, `${label}: committed cursor`).toBe(snapshot.resolvedCommit);
  for (const capsule of expectedCapsules) {
    const actual = await store.getCapsule(capsule.id);
    if (staleCapsuleIds.includes(capsule.id)) {
      expect(actual, `${label}: stale capsule ${capsule.id}`).toEqual({
        ...capsule,
        status: "stale",
        updatedAt: snapshot.fetchedAt,
      });
    } else {
      expect(actual, `${label}: unchanged capsule ${capsule.id}`).toEqual(capsule);
    }
  }
  const staleActivityIds = (await store.listActivityEvents(WORKSPACE_ID, { limit: 100 }))
    .filter((event) => event.action === "capsule.stale")
    .map((event) => event.targetId)
    .sort();
  expect(staleActivityIds, `${label}: stale activity`).toEqual(
    [...staleCapsuleIds].sort(),
  );
}

async function stores(): Promise<
  readonly (readonly [string, OpenTofuControlStore])[]
> {
  const pgClient = await PGliteSqlClient.create();
  pgClients.push(pgClient);
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client: pgClient })],
    ["d1", new CloudflareD1OpenTofuControlStore(new BoundedSqliteFakeD1())],
  ];
}

test("source-sync success atomically publishes its canonical snapshot on every store", async () => {
  for (const [label, store] of await stores()) {
    const running = await claimRun(store, `lease_${label}`);
    const terminal = succeededRun(running, `commit-${label}`);
    const snapshot = sourceSnapshot(`commit-${label}`);

    const committed = await store.commitSourceSyncSuccess({
      terminalRun: terminal,
      leaseToken: `lease_${label}`,
      snapshot,
    });

    expect(committed.won, label).toBe(true);
    expect(await store.getSourceSyncRun(RUN_ID), label).toEqual(terminal);
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), label).toEqual(snapshot);

    const replay = await store.commitSourceSyncSuccess({
      terminalRun: terminal,
      leaseToken: `lease_${label}`,
      snapshot,
    });
    expect(replay.won, `${label}: replay`).toBe(false);
    expect(replay.run?.status, `${label}: replay`).toBe("succeeded");
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), `${label}: replay`).toEqual(
      snapshot,
    );
  }
});

test("source-sync settlement atomically projects stale applied Capsules across stores", async () => {
  for (const [label, store] of await stores()) {
    const changed = await seedAppliedCapsule({
      store,
      capsuleId: `capsule_changed_${label}`,
      snapshotId: `snapshot_changed_${label}`,
      resolvedCommit: `old-changed-${label}`,
    });
    const differentRef = await seedAppliedCapsule({
      store,
      capsuleId: `capsule_ref_${label}`,
      snapshotId: `snapshot_ref_${label}`,
      resolvedCommit: `old-ref-${label}`,
      ref: "refs/heads/release/v2",
    });
    const sameCommit = await seedAppliedCapsule({
      store,
      capsuleId: `capsule_same_${label}`,
      snapshotId: `snapshot_same_${label}`,
      resolvedCommit: `new-${label}`,
    });

    const running = await claimRun(store, `lease_settlement_${label}`);
    const terminal = succeededRun(running, `new-${label}`);
    const snapshot = sourceSnapshot(`new-${label}`);
    const result = await store.commitSourceSyncSuccess({
      terminalRun: terminal,
      leaseToken: `lease_settlement_${label}`,
      snapshot,
    });

    expect(result.won, label).toBe(true);
    expect(await store.getSourceSyncRun(RUN_ID), `${label}:run`).toEqual(
      terminal,
    );
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), `${label}:snapshot`).toEqual(
      snapshot,
    );
    expect((await store.getSource(SOURCE_ID))?.lastSeenCommit, `${label}:cursor`).toBe(
      `new-${label}`,
    );
    expect(await store.getCapsule(changed.id), `${label}:changed`).toMatchObject({
      status: "stale",
      updatedAt: FINISHED_AT,
    });
    expect(await store.getCapsule(differentRef.id), `${label}:ref`).toEqual(
      differentRef,
    );
    expect(await store.getCapsule(sameCommit.id), `${label}:same-commit`).toEqual(
      sameCommit,
    );

    const activity = await store.listActivityEvents(WORKSPACE_ID, { limit: 100 });
    expect(activity).toContainEqual(
      expect.objectContaining({
        action: "capsule.stale",
        targetType: "capsule",
        targetId: changed.id,
      }),
    );
    expect(
      activity.filter(
        (event) =>
          event.action === "capsule.stale" &&
          [differentRef.id, sameCommit.id].includes(event.targetId),
      ),
    ).toEqual([]);
  }
});

test("source-sync settlement rejects a forged SourceSync creation identity", async () => {
  const identityCases = [
    {
      name: "source",
      mutate: (run: SourceSyncRun) => ({
        ...run,
        sourceId: "src_forged_source",
      }),
      snapshot: { sourceId: "src_forged_source" },
    },
    {
      name: "ref",
      mutate: (run: SourceSyncRun) => ({
        ...run,
        ref: "refs/heads/forged",
      }),
      snapshot: { ref: "refs/heads/forged" },
    },
    {
      name: "archive",
      mutate: (run: SourceSyncRun) => ({
        ...run,
        archiveRef: `${ARCHIVE_REF}/forged-archive`,
      }),
      snapshot: { archiveRef: `${ARCHIVE_REF}/forged-archive` },
    },
    {
      name: "snapshot",
      mutate: (run: SourceSyncRun) => ({ ...run, snapshotId: "snapshot_forged" }),
      snapshot: { id: "snapshot_forged" },
    },
  ] as const;
  for (const identityCase of identityCases) {
    for (const [label, store] of await stores()) {
      const leaseToken = `lease_forged_identity_${identityCase.name}_${label}`;
      const running = await claimRun(store, leaseToken);
      const terminal = identityCase.mutate(
        succeededRun(running, `forged-${identityCase.name}-${label}`),
      );
      const snapshot = sourceSnapshot(terminal.resolvedCommit!, identityCase.snapshot);
      const result = await store.commitSourceSyncSuccess({
        terminalRun: terminal,
        leaseToken,
        snapshot,
      });

      expect(result, `${identityCase.name}:${label}`).toEqual({
        won: false,
        run: running,
      });
      expect(await store.getSourceSyncRun(RUN_ID), `${identityCase.name}:${label}: run`).toEqual(running);
      expect(await store.getSourceSnapshot(SNAPSHOT_ID), `${identityCase.name}:${label}: snapshot`).toBeUndefined();
      expect(await store.listActivityEvents(WORKSPACE_ID), `${identityCase.name}:${label}: events`).toEqual([]);
    }
  }
});

test("source-sync settlement may fill a legacy missing Snapshot id without changing creation coordinates", async () => {
  for (const [label, store] of await stores()) {
    const leaseToken = `lease_missing_snapshot_${label}`;
    const running = await claimRun(store, leaseToken, {
      ...queuedRun(), snapshotId: undefined,
    });
    const terminal = succeededRun(running, `legacy-missing-${label}`);
    const snapshot = sourceSnapshot(terminal.resolvedCommit!);
    expect(await store.commitSourceSyncSuccess({ terminalRun: terminal, leaseToken, snapshot }), label)
      .toEqual({ won: true, run: terminal, staleCapsules: [] });
    expect(await store.getSourceSnapshot(snapshot.id), label).toEqual(snapshot);
  }
});

test("source-sync settlement rejects concurrent Capsule census changes before publishing", async () => {
  for (const [label, store] of settlementStores()) {
    const addedFixture = await seedSourceSettlementFixture(label, store);
    const late = await prepareAppliedCapsule(
      store,
      addedFixture.changed,
      `${label}_new`,
    );
    await persistAppliedLineage(store, late, false);
    let interleaved = false;
    store.armAfterSourceSnapshotRead(
      `snapshot_same_${label}`,
      async () => {
        interleaved = true;
        // The lineage was prepared before the observation; only the Capsule
        // row arrives after the bounded census has been observed.
        await store.putCapsule(late.capsule);
      },
    );
    const first = store.commitSourceSyncSuccess({
      terminalRun: addedFixture.terminal,
      leaseToken: `lease_settlement_${label}`,
      snapshot: addedFixture.snapshot,
    });
    await expect(first, `${label}: first commit`).rejects.toThrow(
      "SourceSync settlement observations changed",
    );
    expect(interleaved, `${label}: interleave`).toBe(true);
    await assertSettlementRefused(addedFixture, [
      addedFixture.changed,
      addedFixture.differentRef,
      addedFixture.sameCommit,
      late.capsule,
    ]);

    await assertSettlementCommitted(
      addedFixture,
      [addedFixture.changed.id, late.capsule.id],
      [
        addedFixture.changed,
        addedFixture.differentRef,
        addedFixture.sameCommit,
        late.capsule,
      ],
    );

    const toggledStore: InterleavingSettlementStore =
      label === "memory"
        ? new InterleavingMemorySettlementStore()
        : new InterleavingD1SettlementStore(new BoundedSqliteFakeD1());
    const toggledFixture = await seedSourceSettlementFixture(label, toggledStore);
    let toggleInterleaved = false;
    const toggled = { ...toggledFixture.changed, autoUpdate: true };
    toggledStore.armAfterSourceSnapshotRead(
      `snapshot_same_${label}`,
      async () => {
        toggleInterleaved = true;
        await toggledStore.putCapsule(toggled);
      },
    );
    const toggledFirst = toggledStore.commitSourceSyncSuccess({
      terminalRun: toggledFixture.terminal,
      leaseToken: `lease_settlement_${label}`,
      snapshot: toggledFixture.snapshot,
    });
    await expect(toggledFirst, `${label}: auto-update first commit`).rejects.toThrow(
      "SourceSync settlement observations changed",
    );
    expect(toggleInterleaved, `${label}: auto-update interleave`).toBe(true);
    await assertSettlementRefused(toggledFixture, [
      toggled,
      toggledFixture.differentRef,
      toggledFixture.sameCommit,
    ]);
    await assertSettlementCommitted(
      toggledFixture,
      [toggled.id],
      [toggled, toggledFixture.differentRef, toggledFixture.sameCommit],
    );
  }
});

test("source-sync settlement rejects provenance changes observed after a snapshot read", async () => {
  for (const [label, store] of settlementStores()) {
    const fixture = await seedSourceSettlementFixture(label, store);
    const originalPlan = await store.getPlanRun(`plan_${fixture.changed.id}`);
    if (!originalPlan) throw new Error("source settlement fixture PlanRun missing");
    const changedPlan: PlanRun = {
      ...originalPlan,
      sourceSnapshotId: `snapshot_ref_${label}`,
    };
    let interleaved = false;
    store.armAfterSourceSnapshotRead(
      `snapshot_same_${label}`,
      async () => {
        interleaved = true;
        await store.putPlanRun(changedPlan);
      },
    );
    const first = store.commitSourceSyncSuccess({
      terminalRun: fixture.terminal,
      leaseToken: `lease_settlement_${label}`,
      snapshot: fixture.snapshot,
    });
    await expect(first, `${label}: provenance first commit`).rejects.toThrow(
      "SourceSync settlement observations changed",
    );
    expect(interleaved, `${label}: provenance interleave`).toBe(true);
    await assertSettlementRefused(fixture, [
      fixture.changed,
      fixture.differentRef,
      fixture.sameCommit,
    ]);
    expect(await store.getPlanRun(originalPlan.id), `${label}: changed provenance`).toEqual(
      changedPlan,
    );

    await store.putPlanRun(originalPlan);
    await assertSettlementCommitted(
      fixture,
      [fixture.changed.id],
      [fixture.changed, fixture.differentRef, fixture.sameCommit],
    );
  }
});

test("source-sync settlement keeps coherent destroyed Capsule tombstones outside the census budget", async () => {
  for (const [label, store] of settlementStores()) {
    const fixture = await seedSourceSettlementFixture(label, store);
    const tombstones: Capsule[] = [];
    for (let index = 0; index <= 1_000; index += 1) {
      const tombstone: Capsule = {
        ...fixture.sameCommit,
        id: `capsule_destroyed_${label}_${index}`,
        name: `destroyed-${label}-${index}`,
        slug: `destroyed-${label}-${index}`,
        currentStateVersionId: undefined,
        currentStateGeneration: 0,
        status: "destroyed",
      };
      await store.putCapsule(tombstone);
      if (index === 0 || index === 1_000) tombstones.push(tombstone);
    }

    await assertSettlementCommitted(
      fixture,
      [fixture.changed.id],
      [fixture.changed, fixture.differentRef, fixture.sameCommit],
    );
    for (const tombstone of tombstones) {
      expect(await store.getCapsule(tombstone.id), `${label}: tombstone`).toEqual(
        tombstone,
      );
    }
  }
});

test("source-sync settlement rejects a D1 Capsule physical/JSON tombstone mismatch", async () => {
  const db = new BoundedSqliteFakeD1();
  const store = new InterleavingD1SettlementStore(db);
  const fixture = await seedSourceSettlementFixture("physical_mismatch", store);
  const tombstone: Capsule = {
    ...fixture.sameCommit,
    id: "capsule_destroyed_physical_mismatch",
    name: "destroyed-physical-mismatch",
    slug: "destroyed-physical-mismatch",
    currentStateVersionId: undefined,
    currentStateGeneration: 0,
    status: "destroyed",
  };
  await store.putCapsule(tombstone);
  // Keep record_json terminal while corrupting the searchable physical status.
  await db.prepare("update capsules set status = ? where id = ?")
    .bind("active", tombstone.id)
    .run();

  await expect(
    store.commitSourceSyncSuccess({
      terminalRun: fixture.terminal,
      leaseToken: "lease_settlement_physical_mismatch",
      snapshot: fixture.snapshot,
    }),
  ).rejects.toThrow();
  expect((await store.getSourceSyncRun(RUN_ID))?.status).toBe("running");
  expect(await store.getSourceSnapshot(SNAPSHOT_ID)).toBeUndefined();
  expect((await store.getSource(SOURCE_ID))?.lastSeenCommit).toBeUndefined();
  expect(await store.listActivityEvents(WORKSPACE_ID)).toEqual([]);
  expect(await store.getCapsule(tombstone.id)).toEqual(tombstone);
});

test("postgres source-sync settlement rejects physical lineage drift before publication", async () => {
  const cases = [
    {
      name: "Source owner",
      target: (fixture: SourceSettlementFixture) => SOURCE_ID,
      corrupt: (client: PGliteSqlClient, id: string) =>
        client.query(
          "update takosumi_sources set space_id = $1 where id = $2",
          ["workspace_corrupt", id],
        ),
      restore: (client: PGliteSqlClient, id: string) =>
        client.query(
          "update takosumi_sources set space_id = $1 where id = $2",
          [WORKSPACE_ID, id],
        ),
    },
    {
      name: "Source status",
      target: (fixture: SourceSettlementFixture) => SOURCE_ID,
      corrupt: (client: PGliteSqlClient, id: string) =>
        client.query(
          "update takosumi_sources set status = $1 where id = $2",
          ["disabled", id],
        ),
      restore: (client: PGliteSqlClient, id: string) =>
        client.query(
          "update takosumi_sources set status = $1 where id = $2",
          ["active", id],
        ),
    },
    {
      name: "SourceSnapshot source owner",
      target: (fixture: SourceSettlementFixture) =>
        `snapshot_changed_${fixture.label}`,
      corrupt: (client: PGliteSqlClient, id: string) =>
        client.query(
          "update takosumi_source_snapshots set source_id = $1 where id = $2",
          ["source_corrupt", id],
        ),
      restore: (client: PGliteSqlClient, id: string) =>
        client.query(
          "update takosumi_source_snapshots set source_id = $1 where id = $2",
          [SOURCE_ID, id],
        ),
    },
    {
      name: "StateVersion scope",
      target: (fixture: SourceSettlementFixture) =>
        `state_${fixture.changed.id}`,
      corrupt: (client: PGliteSqlClient, id: string) =>
        client.query(
          "update takosumi_state_versions set space_id = $1 where id = $2",
          ["workspace_corrupt", id],
        ),
      restore: (client: PGliteSqlClient, id: string) =>
        client.query(
          "update takosumi_state_versions set space_id = $1 where id = $2",
          [WORKSPACE_ID, id],
        ),
    },
    {
      name: "Run family",
      target: (fixture: SourceSettlementFixture) =>
        `apply_${fixture.changed.id}`,
      corrupt: (client: PGliteSqlClient, id: string) =>
        client.query(
          "update takosumi_runs set kind = $1 where id = $2",
          ["plan", id],
        ),
      restore: (client: PGliteSqlClient, id: string) =>
        client.query(
          "update takosumi_runs set kind = $1 where id = $2",
          ["apply", id],
        ),
    },
  ] as const;

  for (const corruption of cases) {
    const client = await PGliteSqlClient.create();
    pgClients.push(client);
    const store = new SqlOpenTofuControlStore({ client });
    const fixture = await seedSourceSettlementFixture(
      `postgres_physical_${corruption.name.replaceAll(" ", "_")}`,
      store,
    );
    const id = corruption.target(fixture);
    await corruption.corrupt(client, id);

    await expect(
      store.commitSourceSyncSuccess({
        terminalRun: fixture.terminal,
        leaseToken: `lease_settlement_${fixture.label}`,
        snapshot: fixture.snapshot,
      }),
      corruption.name,
    ).rejects.toThrow();
    await assertSettlementRefused(fixture, [
      fixture.changed,
      fixture.differentRef,
      fixture.sameCommit,
    ]);

    await corruption.restore(client, id);
    await assertSettlementCommitted(
      fixture,
      [fixture.changed.id],
      [fixture.changed, fixture.differentRef, fixture.sameCommit],
    );
  }
});

test("source-sync settlement refuses missing applied lineage before publication", async () => {
  for (const [label, store] of settlementStores()) {
    const changed = await seedAppliedCapsule({
      store,
      capsuleId: `capsule_missing_lineage_${label}`,
      snapshotId: `snapshot_missing_lineage_${label}`,
      resolvedCommit: `old-missing-lineage-${label}`,
    });
    const malformed: Capsule = {
      ...changed,
      currentStateVersionId: `state_missing_lineage_${label}`,
      currentStateGeneration: 1,
    };
    await store.putCapsule(malformed);
    const running = await claimRun(store, `lease_missing_lineage_${label}`);
    const terminal = succeededRun(running, `new-missing-lineage-${label}`);
    const snapshot = sourceSnapshot(`new-missing-lineage-${label}`);

    await expect(
      store.commitSourceSyncSuccess({
        terminalRun: terminal,
        leaseToken: `lease_missing_lineage_${label}`,
        snapshot,
      }),
    ).rejects.toThrow();
    expect((await store.getSourceSyncRun(RUN_ID))?.status, `${label}: run`).toBe("running");
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), `${label}: snapshot`).toBeUndefined();
    expect((await store.getSource(SOURCE_ID))?.lastSeenCommit, `${label}: cursor`).toBeUndefined();
    expect(await store.listActivityEvents(WORKSPACE_ID), `${label}: events`).toEqual([]);
    expect(await store.getCapsule(malformed.id), `${label}: malformed capsule`).toEqual(malformed);
  }
});

test("source-sync settlement rolls back all D1 writes when Activity insertion fails", async () => {
  const db = new BoundedSqliteFakeD1();
  const store = new InterleavingD1SettlementStore(db);
  const fixture = await seedSourceSettlementFixture("activity_fault", store);
  await db.exec(`
    create trigger fail_source_sync_activity
    before insert on audit_events
    begin
      select raise(abort, 'injected source sync Activity write failure');
    end;
  `);

  await expect(
    store.commitSourceSyncSuccess({
      terminalRun: fixture.terminal,
      leaseToken: "lease_settlement_activity_fault",
      snapshot: fixture.snapshot,
    }),
  ).rejects.toThrow("injected source sync Activity write failure");
  await assertSettlementRefused(fixture, [
    fixture.changed,
    fixture.differentRef,
    fixture.sameCommit,
  ]);

  await db.exec("drop trigger fail_source_sync_activity");
  await assertSettlementCommitted(
    fixture,
    [fixture.changed.id],
    [fixture.changed, fixture.differentRef, fixture.sameCommit],
  );
});

test("same-lease Source success advances only its default cursor atomically while draining", async () => {
  for (const [label, store] of await stores()) {
    const running = await claimRun(store, `lease_cursor_${label}`);
    const source = {
      id: SOURCE_ID,
      workspaceId: WORKSPACE_ID,
      name: "configuration-kept",
      url: running.url,
      defaultRef: running.ref,
      defaultPath: running.path,
      hookSecretHash: "hook-hash-kept",
      autoSync: false,
      status: "active" as const,
      lastSeenCommit: "previous-commit",
      createdAt: CREATED_AT,
      updatedAt: STARTED_AT,
    };
    await store.putSource(source);
    await store.beginWorkspaceDraining(WORKSPACE_ID, {
      workspaceId: WORKSPACE_ID, managementState: "active", managementEpoch: 1,
    });
    expect((await store.commitSourceSyncSuccess({
      terminalRun: succeededRun(running, "next-commit"),
      leaseToken: `lease_cursor_${label}`,
      snapshot: sourceSnapshot("next-commit"),
    })).won).toBe(true);
    expect(await store.getSource(SOURCE_ID), label).toEqual({
      ...source,
      lastSeenCommit: "next-commit",
      updatedAt: FINISHED_AT,
    });
  }
});

test("source-sync success exactly adopts an identical immutable snapshot", async () => {
  for (const [label, store] of await stores()) {
    const snapshot = sourceSnapshot(`adopt-${label}`);
    await store.putSourceSnapshot(snapshot);
    const running = await claimRun(store, `lease_adopt_${label}`);
    const terminal = succeededRun(running, `adopt-${label}`);

    const committed = await store.commitSourceSyncSuccess({
      terminalRun: terminal,
      leaseToken: `lease_adopt_${label}`,
      snapshot,
    });

    expect(committed.won, label).toBe(true);
    expect(await store.getSourceSyncRun(RUN_ID), label).toEqual(terminal);
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), label).toEqual(snapshot);
  }
});

test("a snapshot id collision rolls back the terminal run and preserves immutable content", async () => {
  for (const [label, store] of await stores()) {
    const existing = sourceSnapshot(`existing-${label}`);
    await store.putSourceSnapshot(existing);
    const running = await claimRun(store, `lease_collision_${label}`);
    const terminal = succeededRun(running, `candidate-${label}`);
    const candidate = sourceSnapshot(`candidate-${label}`);
    const source = {
      id: SOURCE_ID,
      workspaceId: WORKSPACE_ID,
      name: "collision-cursor",
      url: running.url,
      defaultRef: running.ref,
      defaultPath: running.path,
      hookSecretHash: "kept-hash",
      autoSync: false,
      status: "active" as const,
      lastSeenCommit: "kept-commit",
      createdAt: CREATED_AT,
      updatedAt: STARTED_AT,
    };
    await store.putSource(source);

    await expect(
      Promise.resolve().then(() =>
        store.commitSourceSyncSuccess({
          terminalRun: terminal,
          leaseToken: `lease_collision_${label}`,
          snapshot: candidate,
        }),
      ),
    ).rejects.toThrow("different canonical content");

    expect((await store.getSourceSyncRun(RUN_ID))?.status, label).toBe("running");
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), label).toEqual(existing);
    expect(await store.getSource(SOURCE_ID), label).toEqual(source);
  }
});

test("a stale source-sync lease cannot publish or overwrite the winner snapshot", async () => {
  for (const [label, store] of await stores()) {
    const firstRunning = await claimRun(store, `lease_first_${label}`);
    const winnerRunning: SourceSyncRun = {
      ...firstRunning,
      heartbeatAt: 1_500,
      updatedAt: "2026-08-27T00:00:01.500Z",
    };
    const takeover = await store.transitionRun({
      id: RUN_ID,
      kind: "source_sync",
      expectFrom: ["running"],
      expectHeartbeatAt: firstRunning.heartbeatAt ?? null,
      run: winnerRunning,
      setLeaseToken: `lease_winner_${label}`,
      heartbeatAt: winnerRunning.heartbeatAt,
    });
    expect(takeover.won, label).toBe(true);

    const staleCommit = await store.commitSourceSyncSuccess({
      terminalRun: succeededRun(firstRunning, `stale-${label}`),
      leaseToken: `lease_first_${label}`,
      snapshot: sourceSnapshot(`stale-${label}`),
    });
    expect(staleCommit.won, `${label}: stale`).toBe(false);
    expect(staleCommit.run?.status, `${label}: stale`).toBe("running");
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), `${label}: stale`).toBeUndefined();
    expect(await store.listActivityEvents(WORKSPACE_ID), `${label}: stale activity`).toEqual([]);

    const winnerTerminal = succeededRun(
      takeover.run as SourceSyncRun,
      `winner-${label}`,
    );
    const winnerSnapshot = sourceSnapshot(`winner-${label}`);
    const winnerCommit = await store.commitSourceSyncSuccess({
      terminalRun: winnerTerminal,
      leaseToken: `lease_winner_${label}`,
      snapshot: winnerSnapshot,
    });
    expect(winnerCommit.won, `${label}: winner`).toBe(true);
    expect(await store.getSourceSyncRun(RUN_ID), `${label}: winner`).toEqual(
      winnerTerminal,
    );
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), `${label}: winner`).toEqual(
      winnerSnapshot,
    );
  }
});

test("stores reject a succeeded source-sync run paired with a non-canonical snapshot", async () => {
  for (const [label, store] of await stores()) {
    const running = await claimRun(store, `lease_mismatch_${label}`);
    const terminal = succeededRun(running, `mismatch-${label}`);
    const mismatchedSnapshot: SourceSnapshot = {
      ...sourceSnapshot(`mismatch-${label}`),
      fetchedByRunId: "ssr_other_run",
    };

    await expect(
      Promise.resolve().then(() =>
        store.commitSourceSyncSuccess({
          terminalRun: terminal,
          leaseToken: `lease_mismatch_${label}`,
          snapshot: mismatchedSnapshot,
        }),
      ),
    ).rejects.toThrow("exact canonical SourceSnapshot");
    expect((await store.getSourceSyncRun(RUN_ID))?.status, label).toBe("running");
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), label).toBeUndefined();
  }
});

test("source-sync success cannot move a held Run to another Workspace", async () => {
  for (const [label, store] of await stores()) {
    const running = await claimRun(store, `lease_owner_${label}`);
    const otherWorkspaceId = `other-workspace-${label}`;
    await store.putWorkspace({ ...workspace(), id: otherWorkspaceId, handle: `other-${label}`, ownerUserId: `other-owner-${label}` });
    const terminal = { ...succeededRun(running, `owner-${label}`), workspaceId: otherWorkspaceId };
    const snapshot = { ...sourceSnapshot(`owner-${label}`), workspaceId: otherWorkspaceId };
    expect(await store.commitSourceSyncSuccess({
      terminalRun: terminal, leaseToken: `lease_owner_${label}`, snapshot,
    }), label).toEqual({ won: false, run: running });
    expect(await store.getSourceSyncRun(RUN_ID), label).toEqual(running);
    expect(await store.getSourceSnapshot(SNAPSHOT_ID), label).toBeUndefined();
  }
});

test("postgres SourceSync success tolerates a concurrent heartbeat on the same held lease", async () => {
  const backing = await PGliteSqlClient.create();
  pgClients.push(backing);
  let armed = false;
  let interleaved = false;
  const client: SqlClient = {
    query: (statement, parameters) => backing.query(statement, parameters),
    transaction: (callback) => backing.transaction(async (transaction) => {
      const handle: SqlTransaction = {
        transaction: (nested) => transaction.transaction(nested),
        async query<Row extends Record<string, unknown>>(
          statement: string, parameters?: SqlParameters,
        ) {
          if (armed && /^update\b/iu.test(statement.trimStart()) && statement.includes("takosumi_runs")) {
            armed = false;
            interleaved = true;
            // A normal heartbeat does not change status or the held lease.
            // It must not turn an otherwise valid success into a lost-lease CAS.
            await transaction.query(
              "update takosumi_runs set heartbeat_at = 1500, run_json = jsonb_set(run_json::jsonb, '{heartbeatAt}', '1500'::jsonb) where id = $1",
              [RUN_ID],
            );
          }
          return await transaction.query<Row>(statement, parameters);
        },
      };
      return await callback(handle);
    }),
  };
  const store = new SqlOpenTofuControlStore({ client });
  const running = await claimRun(store, "same-lease-heartbeat");
  const terminal = succeededRun(running, "same-lease-commit");
  const snapshot = sourceSnapshot("same-lease-commit");
  armed = true;
  const result = await store.commitSourceSyncSuccess({ terminalRun: terminal, leaseToken: "same-lease-heartbeat", snapshot });
  expect(interleaved).toBe(true);
  expect(result).toEqual({ won: true, run: terminal, staleCapsules: [] });
  expect(await store.getSourceSnapshot(SNAPSHOT_ID)).toEqual(snapshot);
});

test("postgres rolls back the terminal source-sync CAS when the snapshot write fails", async () => {
  const backing = await PGliteSqlClient.create();
  pgClients.push(backing);
  const faulting = new SnapshotFailingSqlClient(backing);
  const store = new SqlOpenTofuControlStore({ client: faulting });
  const running = await claimRun(store, "lease_postgres_fault");
  const terminal = succeededRun(running, "postgres-fault");
  const snapshot = sourceSnapshot("postgres-fault");
  faulting.failNextSnapshotWrite();

  await expect(
    store.commitSourceSyncSuccess({
      terminalRun: terminal,
      leaseToken: "lease_postgres_fault",
      snapshot,
    }),
  ).rejects.toThrow("source_snapshots");

  expect(faulting.runUpdatePrecededFault).toBe(true);
  expect((await store.getSourceSyncRun(RUN_ID))?.status).toBe("running");
  expect(await store.getSourceSnapshot(SNAPSHOT_ID)).toBeUndefined();

  expect(
    (
      await store.commitSourceSyncSuccess({
        terminalRun: terminal,
        leaseToken: "lease_postgres_fault",
        snapshot,
      })
    ).won,
  ).toBe(true);
});

test("d1 rolls back the terminal source-sync CAS when the snapshot write fails", async () => {
  const db = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  const running = await claimRun(store, "lease_d1_fault");
  const terminal = succeededRun(running, "d1-fault");
  const snapshot = sourceSnapshot("d1-fault");
  await db.exec(`
    create trigger fail_source_snapshot
    before insert on source_snapshots
    begin
      select raise(abort, 'injected source snapshot write failure');
    end;
  `);

  await expect(
    store.commitSourceSyncSuccess({
      terminalRun: terminal,
      leaseToken: "lease_d1_fault",
      snapshot,
    }),
  ).rejects.toThrow("injected source snapshot write failure");

  expect((await store.getSourceSyncRun(RUN_ID))?.status).toBe("running");
  expect(await store.getSourceSnapshot(SNAPSHOT_ID)).toBeUndefined();

  await db.exec("drop trigger fail_source_snapshot");
  expect(
    (
      await store.commitSourceSyncSuccess({
        terminalRun: terminal,
        leaseToken: "lease_d1_fault",
        snapshot,
      })
    ).won,
  ).toBe(true);
});

class SnapshotFailingSqlClient implements SqlClient {
  #armed = false;
  runUpdatePrecededFault = false;

  constructor(private readonly inner: SqlClient) {}

  failNextSnapshotWrite(): void {
    this.#armed = true;
    this.runUpdatePrecededFault = false;
  }

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    return this.inner.query<Row>(sql, parameters);
  }

  transaction<T>(
    fn: (transaction: SqlTransaction) => T | Promise<T>,
  ): Promise<T> {
    return this.inner.transaction(async (transaction) => {
      let sawRunUpdate = false;
      const handle: SqlTransaction = {
        query: async <
          Row extends Record<string, unknown> = Record<string, unknown>,
        >(
          sql: string,
          parameters?: SqlParameters,
        ): Promise<SqlQueryResult<Row>> => {
          const normalized = sql.trimStart().toLowerCase();
          if (normalized.startsWith("update") && normalized.includes("runs")) {
            sawRunUpdate = true;
          }
          if (
            this.#armed &&
            normalized.startsWith("insert") &&
            normalized.includes("source_snapshots")
          ) {
            this.#armed = false;
            this.runUpdatePrecededFault = sawRunUpdate;
            throw new Error("injected source snapshot write failure");
          }
          return await transaction.query<Row>(sql, parameters);
        },
        transaction: async <Nested>(
          nested: (
            transaction: SqlTransaction,
          ) => Nested | Promise<Nested>,
        ): Promise<Nested> => await nested(handle),
      };
      return await fn(handle);
    });
  }
}
