import { expect, test } from "bun:test";

import {
  OpenTofuController,
  type ApplyRun,
  type OpenTofuApplyJob,
  type PlanRun,
  type OpenTofuPlanJob,
  type OpenTofuSourceSyncJob,
  type OpenTofuSourceSyncResult,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import { StaticSecretConnectionVault } from "../../../../core/adapters/vault/mod.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const TEST_TIME = "2026-06-06T00:00:00.000Z";

class StubRunner {
  readonly calls: OpenTofuSourceSyncJob[] = [];
  result: OpenTofuSourceSyncResult = {
    resolvedCommit: "abc123def456",
    archiveDigest: "sha256:" + "a".repeat(64),
    archiveSizeBytes: 4096,
  };
  fail = false;
  onSourceSync?: (job: OpenTofuSourceSyncJob) => Promise<void>;

  plan(_job: OpenTofuPlanJob): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  apply(_job: OpenTofuApplyJob): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  async sourceSync(
    job: OpenTofuSourceSyncJob,
  ): Promise<OpenTofuSourceSyncResult> {
    this.calls.push(job);
    await this.onSourceSync?.(job);
    if (this.fail) throw new Error("runner exploded");
    return {
      repositoryInstallMetadata: { status: "absent" },
      ...this.result,
    };
  }
}

function build(
  options: {
    readonly now?: () => number;
    readonly runRenewalIntervalMs?: number;
  } = {},
) {
  const store = new InMemoryOpenTofuControlStore();
  let counter = 0;
  const newId = (prefix: string) =>
    `${prefix}_test${(counter += 1).toString().padStart(8, "0")}`;
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new PartitionedSecretBoundaryCrypto({
      globalPassphrase: "test-passphrase-0123456789-abcdef-0123456789",
    }),
    now: () => new Date(TEST_TIME),
    newId: () => newId("conn"),
  });
  const sourcesService = new SourcesService({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: () => new Date(TEST_TIME),
    newId,
    newHookSecret: () => "whk_secret",
  });
  const runner = new StubRunner();
  const controller = new OpenTofuController({
    store,
    vault,
    sourcesService,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    runner: runner as never,
    now: options.now ?? (() => 1_000),
    ...(options.runRenewalIntervalMs !== undefined
      ? { runRenewalIntervalMs: options.runRenewalIntervalMs }
      : {}),
  });
  return { store, vault, sourcesService, runner, controller };
}

function sourceSnapshot(over: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    id: "snap_prev",
    origin: "git",
    workspaceId: "workspace_1",
    sourceId: "src_test00000001",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
    ref: "main",
    resolvedCommit: "old123",
    path: ".",
    archiveRef:
      "workspaces/workspace_1/sources/src_test00000001/snapshots/snap_prev/source.tar.zst",
    archiveDigest: "sha256:" + "b".repeat(64),
    archiveSizeBytes: 1024,
    repositoryInstallMetadata: { status: "absent" },
    fetchedByRunId: "ssr_prev",
    fetchedAt: TEST_TIME,
    ...over,
  };
}

async function seedActiveCapsuleOnSnapshot(input: {
  readonly store: InMemoryOpenTofuControlStore;
  readonly sourceId: string;
  readonly snapshot: SourceSnapshot;
}): Promise<void> {
  const source = await input.store.getSource(input.sourceId);
  const { capsule } = await seedCapsuleModel(input.store, {
    workspaceId: "workspace_1",
    capsuleId: "capsule_active",
    sourceId: input.sourceId,
    snapshotId: input.snapshot.id,
    withoutSnapshot: true,
  });
  // The shared model fixture supplies ownership rows; preserve the Source
  // created by SourcesService so this helper does not replace its Git address.
  if (source) await input.store.putSource(source);
  await input.store.putSourceSnapshot(input.snapshot);
  const planRun: PlanRun = {
    id: "plan_prev",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    source: {
      kind: "git",
      url: input.snapshot.url,
      commit: input.snapshot.resolvedCommit,
    },
    sourceDigest: "sha256:source-prev",
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables-prev",
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy-prev",
    planDigest: "sha256:plan-prev",
    sourceSnapshotId: input.snapshot.id,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const applyRun: ApplyRun = {
    id: "apply_prev",
    planRunId: planRun.id,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    stateVersionId: "state_prev",
    operation: "update",
    runnerProfileId: "opentofu-default",
    status: "succeeded",
    expected: {
      planRunId: planRun.id,
      capsuleId: capsule.id,
      runnerProfileId: planRun.runnerProfileId,
      sourceDigest: planRun.sourceDigest,
      variablesDigest: planRun.variablesDigest,
      policyDecisionDigest: planRun.policyDecisionDigest,
      planDigest: planRun.planDigest!,
      planArtifactDigest: "sha256:artifact-prev",
    },
    stateBackend: { kind: "operator-managed", ref: "state://test" },
    stateLock: { status: "recorded", backendRef: "state://test" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await input.store.putPlanRun(planRun);
  await input.store.putApplyRun(applyRun);
  await input.store.putStateVersion({
    id: "state_prev",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    generation: 1,
    stateRef: "state-ref-prev",
    digest: "sha256:state-prev",
    createdByRunId: applyRun.id,
    createdAt: TEST_TIME,
  });
  await input.store.putCapsule({
    ...capsule,
    currentStateGeneration: 1,
    currentStateVersionId: "state_prev",
    status: "active",
    updatedAt: TEST_TIME,
  });
}

test("source_sync consumer (public repo) records a snapshot and lastSeenCommit", async () => {
  const { store, sourcesService, runner, controller } = build();
  runner.result = {
    ...runner.result,
    phaseTimings: [
      {
        phase: "source_ref_resolve",
        startedAt: "2026-06-06T00:00:01.000Z",
        finishedAt: "2026-06-06T00:00:01.042Z",
        durationMs: 42,
      },
      {
        phase: "source_archive_upload",
        startedAt: "2026-06-06T00:00:02.000Z",
        finishedAt: "2026-06-06T00:00:02.125Z",
        durationMs: 125,
      },
    ],
  };
  const { source } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
  });
  const { run } = await controller.createSourceSync(source.id);

  await controller.dispatchQueuedRun({
    action: "source_sync",
    runId: run.id,
    workspaceId: "workspace_1",
  });

  // Public repo: no credentials were minted.
  expect(runner.calls).toHaveLength(1);
  expect(runner.calls[0].credentials).toBeUndefined();
  expect(runner.calls[0].archiveRef).toBe(run.archiveRef);

  const finished = await store.getSourceSyncRun(run.id);
  expect(finished?.status).toBe("succeeded");
  expect(finished?.resolvedCommit).toBe("abc123def456");
  expect(finished?.archiveDigest).toBe(runner.result.archiveDigest);
  expect(finished?.phaseTimings?.map((timing) => timing.phase)).toEqual([
    "source_ref_resolve",
    "source_archive_upload",
  ]);
  expect((await controller.getRunLogs(run.id)).diagnostics).toContainEqual({
    severity: "info",
    message: "source sync phase timings recorded",
    detail: "source_ref_resolve=42ms, source_archive_upload=125ms",
  });

  const snapshots = await store.listSourceSnapshots(source.id);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0].resolvedCommit).toBe("abc123def456");
  expect(snapshots[0].archiveRef).toBe(run.archiveRef);

  const stored = await store.getSource(source.id);
  expect(stored?.lastSeenCommit).toBe("abc123def456");
  expect(await store.listCredentialMintEventsForRun(run.id)).toEqual([]);
});

test("source_sync fails terminally when the selected runner lacks source-sync capability", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const artifactReferenceAllocator = new ObjectKeyArtifactReferenceAllocator();
  const sourcesService = new SourcesService({
    store,
    artifactReferenceAllocator,
    now: () => new Date(TEST_TIME),
    newId: (prefix) => `${prefix}_missing_capability`,
    newHookSecret: () => "whk_secret",
  });
  const controller = new OpenTofuController({
    store,
    sourcesService,
    artifactReferenceAllocator,
    now: () => 1_000,
    newId: (prefix) => `${prefix}_missing_capability`,
  });
  const { source } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo",
    url: "https://example.com/acme/repo.git",
  });
  const { run } = await controller.createSourceSync(source.id);

  const finished = await controller.runQueuedSourceSync(run.id);

  expect(finished?.status).toBe("failed");
  expect(finished?.errorCode).toBe("runner_capability_missing");
  expect((await controller.getRun(run.id)).errorCode).toBe(
    "runner_capability_missing",
  );
  expect(await controller.getRunLogs(run.id)).toEqual(
    expect.objectContaining({
      diagnostics: [
        expect.objectContaining({
          severity: "error",
          code: "runner_capability_missing",
        }),
      ],
    }),
  );
});

test("source_sync consumer marks active source Capsules stale when the resolved commit changes", async () => {
  const { store, sourcesService, runner, controller } = build();
  const { source } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
  });
  await seedActiveCapsuleOnSnapshot({
    store,
    sourceId: source.id,
    snapshot: sourceSnapshot({ sourceId: source.id }),
  });
  runner.result = {
    resolvedCommit: "new123",
    archiveDigest: "sha256:" + "c".repeat(64),
    archiveSizeBytes: 2048,
  };

  const { run } = await controller.createSourceSync(source.id);
  await controller.runQueuedSourceSync(run.id);

  const capsule = await store.getCapsule("capsule_active");
  expect(capsule?.status).toBe("stale");
  const activity = await store.listActivityEvents("workspace_1", { limit: 10 });
  expect(activity).toContainEqual(
    expect.objectContaining({
      action: "capsule.stale",
      targetId: "capsule_active",
      metadata: expect.objectContaining({
        reason: "source_ref_changed",
        sourceId: source.id,
        previousResolvedCommit: "old123",
        resolvedCommit: "new123",
      }),
    }),
  );
});

test("source_sync consumer does not mark Capsules stale when only the snapshot id changes for the same commit", async () => {
  const { store, sourcesService, runner, controller } = build();
  const { source } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
  });
  await seedActiveCapsuleOnSnapshot({
    store,
    sourceId: source.id,
    snapshot: sourceSnapshot({
      sourceId: source.id,
      resolvedCommit: runner.result.resolvedCommit,
      archiveDigest: runner.result.archiveDigest,
      archiveSizeBytes: runner.result.archiveSizeBytes,
    }),
  });

  const { run } = await controller.createSourceSync(source.id);
  await controller.runQueuedSourceSync(run.id);

  const capsule = await store.getCapsule("capsule_active");
  expect(capsule?.status).toBe("active");
  expect(await store.listActivityEvents("workspace_1", { limit: 10 })).toEqual(
    [],
  );
});

test("source_sync consumer reuses an unchanged SourceSnapshot archive", async () => {
  const { store, sourcesService, runner, controller } = build();
  const { source } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
  });
  const previousArchiveKey =
    "workspaces/workspace_1/sources/src_prev/snapshots/snap_prev/source.tar.zst";
  const previousDigest = "sha256:" + "b".repeat(64);
  await store.putSourceSnapshot({
    id: "snap_prev",
    origin: "git",
    workspaceId: "workspace_1",
    sourceId: source.id,
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
    ref: "main",
    resolvedCommit: "abc123def456",
    path: ".",
    archiveRef: previousArchiveKey,
    archiveDigest: previousDigest,
    archiveSizeBytes: 2048,
    repositoryInstallMetadata: { status: "absent" },
    fetchedByRunId: "ssr_prev",
    fetchedAt: "1970-01-01T00:00:00.000Z",
  });
  runner.onSourceSync = async (job) => {
    expect(job.reuseSnapshot).toEqual({
      id: "snap_prev",
      resolvedCommit: "abc123def456",
      archiveRef: previousArchiveKey,
      archiveDigest: previousDigest,
      archiveSizeBytes: 2048,
    });
    runner.result = {
      resolvedCommit: job.reuseSnapshot!.resolvedCommit,
      archiveDigest: job.reuseSnapshot!.archiveDigest,
      archiveSizeBytes: job.reuseSnapshot!.archiveSizeBytes,
      archiveRef: job.reuseSnapshot!.archiveRef,
    };
  };
  const { run } = await controller.createSourceSync(source.id);

  await controller.dispatchQueuedRun({
    action: "source_sync",
    runId: run.id,
    workspaceId: "workspace_1",
  });

  expect(runner.calls).toHaveLength(1);
  const finished = await store.getSourceSyncRun(run.id);
  expect(finished?.status).toBe("succeeded");
  expect(finished?.archiveDigest).toBe(previousDigest);
  const snapshots = await store.listSourceSnapshots(source.id);
  expect(snapshots).toHaveLength(2);
  const reused = snapshots.find(
    (snapshot) => snapshot.fetchedByRunId === run.id,
  );
  expect(reused?.archiveRef).toBe(previousArchiveKey);
  expect(reused?.archiveDigest).toBe(previousDigest);
  expect(reused?.archiveSizeBytes).toBe(2048);
});

test("source_sync consumer does not reuse a snapshot that predates repository metadata observation", async () => {
  const { store, sourcesService, runner, controller } = build();
  const { source } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
  });
  await store.putSourceSnapshot({
    id: "snap_without_repository_metadata",
    origin: "git",
    workspaceId: "workspace_1",
    sourceId: source.id,
    url: source.url,
    ref: source.defaultRef,
    resolvedCommit: runner.result.resolvedCommit,
    path: source.defaultPath,
    archiveRef:
      "workspaces/workspace_1/sources/src_old/snapshots/snap_old/source.tar.zst",
    archiveDigest: "sha256:" + "d".repeat(64),
    archiveSizeBytes: 2048,
    fetchedByRunId: "ssr_old",
    fetchedAt: "1970-01-01T00:00:00.000Z",
  });
  runner.onSourceSync = async (job) => {
    expect(job.reuseSnapshot).toBeUndefined();
  };

  const { run } = await controller.createSourceSync(source.id);
  await controller.runQueuedSourceSync(run.id);

  expect((await store.getSourceSyncRun(run.id))?.status).toBe("succeeded");
  const snapshots = await store.listSourceSnapshots(source.id);
  expect(snapshots).toHaveLength(2);
  expect(snapshots.at(-1)?.repositoryInstallMetadata).toEqual({
    status: "absent",
  });
  expect(snapshots.at(-1)?.archiveRef).toBe(run.archiveRef);
});

test("source_sync consumer reuses an unchanged public Git archive from a sibling Source in the same Workspace", async () => {
  const { store, sourcesService, runner, controller } = build();
  const { source: firstSource } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo-a",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
  });
  const { source: secondSource } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo-b",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
  });
  const previousArchiveKey =
    "workspaces/workspace_1/sources/src_prev/snapshots/snap_prev/source.tar.zst";
  const previousDigest = "sha256:" + "b".repeat(64);
  await store.putSourceSnapshot({
    id: "snap_prev",
    origin: "git",
    workspaceId: "workspace_1",
    sourceId: firstSource.id,
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
    ref: "main",
    resolvedCommit: "abc123def456",
    path: ".",
    archiveRef: previousArchiveKey,
    archiveDigest: previousDigest,
    archiveSizeBytes: 2048,
    repositoryInstallMetadata: { status: "absent" },
    fetchedByRunId: "ssr_prev",
    fetchedAt: "1970-01-01T00:00:00.000Z",
  });
  runner.onSourceSync = async (job) => {
    expect(job.reuseSnapshot).toEqual({
      id: "snap_prev",
      resolvedCommit: "abc123def456",
      archiveRef: previousArchiveKey,
      archiveDigest: previousDigest,
      archiveSizeBytes: 2048,
    });
    runner.result = {
      resolvedCommit: job.reuseSnapshot!.resolvedCommit,
      archiveDigest: job.reuseSnapshot!.archiveDigest,
      archiveSizeBytes: job.reuseSnapshot!.archiveSizeBytes,
      archiveRef: job.reuseSnapshot!.archiveRef,
    };
  };
  const { run } = await controller.createSourceSync(secondSource.id);

  await controller.dispatchQueuedRun({
    action: "source_sync",
    runId: run.id,
    workspaceId: "workspace_1",
  });

  const snapshots = await store.listSourceSnapshots(secondSource.id);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.archiveRef).toBe(previousArchiveKey);
  expect(snapshots[0]?.archiveDigest).toBe(previousDigest);
});

test("source_sync consumer fast-reuses a pinned commit SourceSnapshot without dispatching the runner", async () => {
  const { store, sourcesService, runner, controller } = build();
  const pinnedCommit = "ccee6dea39e0797148ec0061fc738a693073890d";
  const { source: firstSource } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo-a",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
    defaultRef: pinnedCommit,
  });
  const { source: secondSource } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo-b",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
    defaultRef: pinnedCommit,
  });
  const previousArchiveKey =
    "workspaces/workspace_1/sources/src_prev/snapshots/snap_prev/source.tar.zst";
  const previousDigest = "sha256:" + "b".repeat(64);
  await store.putSourceSnapshot({
    id: "snap_prev",
    origin: "git",
    workspaceId: "workspace_1",
    sourceId: firstSource.id,
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
    ref: pinnedCommit,
    resolvedCommit: pinnedCommit,
    path: ".",
    archiveRef: previousArchiveKey,
    archiveDigest: previousDigest,
    archiveSizeBytes: 2048,
    repositoryInstallMetadata: { status: "absent" },
    fetchedByRunId: "ssr_prev",
    fetchedAt: "1970-01-01T00:00:00.000Z",
  });
  const { run } = await controller.createSourceSync(secondSource.id);

  await controller.dispatchQueuedRun({
    action: "source_sync",
    runId: run.id,
    workspaceId: "workspace_1",
  });

  expect(runner.calls).toHaveLength(0);
  const finished = await store.getSourceSyncRun(run.id);
  expect(finished?.status).toBe("succeeded");
  expect(finished?.resolvedCommit).toBe(pinnedCommit);
  expect(finished?.archiveDigest).toBe(previousDigest);
  const snapshots = await store.listSourceSnapshots(secondSource.id);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.archiveRef).toBe(previousArchiveKey);
  expect(snapshots[0]?.archiveDigest).toBe(previousDigest);
  expect(snapshots[0]?.resolvedCommit).toBe(pinnedCommit);
});

test("source_sync consumer does not reuse sibling Git archives across credential or Workspace boundaries", async () => {
  const { store, sourcesService, vault, runner, controller } = build();
  const conn = await vault.register({
    workspaceId: "workspace_1",
    provider: "source_git_https_token",
    kind: "source_git_https_token",
    authMethod: "static_secret",
    scope: { username: "git-bot" },
    values: { GIT_HTTPS_TOKEN: "ghp_super_secret" },
  });
  await store.putConnection({
    ...conn,
    status: "verified",
    verifiedAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const { source: publicSource } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "public",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
  });
  const { source: privateSource } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "private",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
    authConnectionId: conn.id,
  });
  const otherWorkspaceStoreSource = {
    id: "src_other_workspace",
    workspaceId: "workspace_2",
    name: "repo-other-space",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
    defaultRef: "main",
    defaultPath: ".",
    status: "active" as const,
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    hookSecretHash: "hash",
    autoSync: false,
  };
  await store.putSource(otherWorkspaceStoreSource);
  await store.putSourceSnapshot({
    id: "snap_public",
    origin: "git",
    workspaceId: "workspace_1",
    sourceId: publicSource.id,
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
    ref: "main",
    resolvedCommit: "abc123def456",
    path: ".",
    archiveRef:
      "workspaces/workspace_1/sources/src_public/snapshots/snap_public/source.tar.zst",
    archiveDigest: "sha256:" + "b".repeat(64),
    archiveSizeBytes: 2048,
    fetchedByRunId: "ssr_public",
    fetchedAt: "1970-01-01T00:00:00.000Z",
  });
  await store.putSourceSnapshot({
    id: "snap_other_workspace",
    origin: "git",
    workspaceId: "workspace_2",
    sourceId: otherWorkspaceStoreSource.id,
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
    ref: "main",
    resolvedCommit: "abc123def456",
    path: ".",
    archiveRef:
      "workspaces/workspace_2/sources/src_other/snapshots/snap_other/source.tar.zst",
    archiveDigest: "sha256:" + "c".repeat(64),
    archiveSizeBytes: 4096,
    fetchedByRunId: "ssr_other",
    fetchedAt: "1970-01-02T00:00:00.000Z",
  });
  runner.onSourceSync = async (job) => {
    expect(job.reuseSnapshot).toBeUndefined();
  };
  const { run } = await controller.createSourceSync(privateSource.id);

  await controller.dispatchQueuedRun({
    action: "source_sync",
    runId: run.id,
    workspaceId: "workspace_1",
  });

  expect(runner.calls).toHaveLength(1);
  expect((await store.getSourceSyncRun(run.id))?.status).toBe("succeeded");
  const snapshots = await store.listSourceSnapshots(privateSource.id);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.archiveDigest).toBe(runner.result.archiveDigest);
});

test("source_sync consumer rejects a reused archive outside the requested snapshot boundary", async () => {
  const { store, sourcesService, runner, controller } = build();
  const { source } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
  });
  await store.putSourceSnapshot({
    id: "snap_prev",
    origin: "git",
    workspaceId: "workspace_1",
    sourceId: source.id,
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
    ref: "main",
    resolvedCommit: "abc123def456",
    path: ".",
    archiveRef:
      "workspaces/workspace_1/sources/src_prev/snapshots/snap_prev/source.tar.zst",
    archiveDigest: "sha256:" + "b".repeat(64),
    archiveSizeBytes: 2048,
    repositoryInstallMetadata: { status: "absent" },
    fetchedByRunId: "ssr_prev",
    fetchedAt: "1970-01-01T00:00:00.000Z",
  });
  runner.onSourceSync = async (job) => {
    runner.result = {
      resolvedCommit: job.reuseSnapshot!.resolvedCommit,
      archiveDigest: job.reuseSnapshot!.archiveDigest,
      archiveSizeBytes: job.reuseSnapshot!.archiveSizeBytes,
      archiveRef:
        "workspaces/other_workspace/sources/src_bad/snapshots/snap_bad/source.tar.zst",
    };
  };
  const { run } = await controller.createSourceSync(source.id);

  await controller.dispatchQueuedRun({
    action: "source_sync",
    runId: run.id,
    workspaceId: "workspace_1",
  });

  const failed = await store.getSourceSyncRun(run.id);
  expect(failed?.status).toBe("failed");
  expect(failed?.error).toContain("SourceSnapshot boundary");
  const snapshots = await store.listSourceSnapshots(source.id);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.fetchedByRunId).toBe("ssr_prev");
});

test("source_sync consumer mints ONLY source-phase git creds for a private repo", async () => {
  const { store, sourcesService, vault, runner, controller } = build();
  const conn = await vault.register({
    workspaceId: "workspace_1",
    provider: "source_git_https_token",
    kind: "source_git_https_token",
    authMethod: "static_secret",
    scope: { username: "git-bot" },
    values: { GIT_HTTPS_TOKEN: "ghp_super_secret" },
  });
  await store.putConnection({
    ...conn,
    status: "verified",
    verifiedAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const { source } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo",
    url: "https://github.com/acme/private.git",
    authConnectionId: conn.id,
  });
  const { run } = await controller.createSourceSync(source.id);
  await controller.dispatchQueuedRun({
    action: "source_sync",
    runId: run.id,
    workspaceId: "workspace_1",
  });

  expect(runner.calls).toHaveLength(1);
  const creds = runner.calls[0].credentials;
  expect(creds).toBeDefined();
  expect(creds?.env.GIT_TERMINAL_PROMPT).toBe("0");
  // The askpass file content carries the secret token (dispatch-path only).
  const askpass = creds?.files?.find((f) => f.path.endsWith("askpass.sh"));
  expect(askpass?.content).toContain("ghp_super_secret");

  const mintEvents = await store.listCredentialMintEventsForRun(run.id);
  expect(mintEvents).toHaveLength(1);
  expect(mintEvents[0]).toMatchObject({
    runId: run.id,
    workspaceId: "workspace_1",
    sourceId: source.id,
    connectionId: conn.id,
    phase: "source",
    capabilities: ["source"],
  });
  expect(mintEvents[0]?.capsuleId).toBeUndefined();
  expect(JSON.stringify(mintEvents)).not.toContain("ghp_super_secret");
});

test("source_sync consumer records the run failed when the runner errors", async () => {
  const { store, sourcesService, runner, controller } = build();
  runner.fail = true;
  const { source } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
  });
  const { run } = await controller.createSourceSync(source.id);
  await controller.dispatchQueuedRun({
    action: "source_sync",
    runId: run.id,
    workspaceId: "workspace_1",
  });
  const finished = await store.getSourceSyncRun(run.id);
  expect(finished?.status).toBe("failed");
  expect(finished?.error).toContain("runner exploded");
  expect(await store.listSourceSnapshots(source.id)).toHaveLength(0);
});

test("source_sync retry-exhausted backstop marks a queued run failed", async () => {
  const { store, sourcesService, controller } = build();
  const { source } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
  });
  const { run } = await controller.createSourceSync(source.id);

  const transitioned = await controller.markRunFailed(
    "source_sync",
    run.id,
    "retries-exhausted",
  );

  expect(transitioned).toBe(true);
  const failed = await store.getSourceSyncRun(run.id);
  expect(failed?.status).toBe("failed");
  expect(failed?.error).toBe("retries-exhausted");
  expect(await store.listSourceSnapshots(source.id)).toHaveLength(0);
  expect(
    await controller.markRunFailed("source_sync", run.id, "retries-exhausted"),
  ).toBe(false);
});

test("source_sync consumer is idempotent on an already-succeeded run", async () => {
  const { store, sourcesService, runner, controller } = build();
  const { source } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
  });
  const { run } = await controller.createSourceSync(source.id);
  await controller.runQueuedSourceSync(run.id);
  await controller.runQueuedSourceSync(run.id);
  // The runner ran exactly once; the second pass no-ops on the terminal run.
  expect(runner.calls).toHaveLength(1);
  expect((await store.listSourceSnapshots(source.id)).length).toBe(1);
});

test("source_sync consumer renews the run heartbeat while the runner blocks", async () => {
  let clock = 10_000;
  const now = () => (clock += 1);
  const { store, sourcesService, runner, controller } = build({
    now,
    runRenewalIntervalMs: 5,
  });
  const { source } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
  });
  const { run } = await controller.createSourceSync(source.id);
  let claimHeartbeat = 0;
  let midFlightHeartbeat = 0;
  runner.onSourceSync = async () => {
    claimHeartbeat = (await store.getSourceSyncRun(run.id))?.heartbeatAt ?? 0;
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const current = (await store.getSourceSyncRun(run.id))?.heartbeatAt ?? 0;
      if (current > claimHeartbeat) {
        midFlightHeartbeat = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  await controller.runQueuedSourceSync(run.id);

  expect(midFlightHeartbeat).toBeGreaterThan(claimHeartbeat);
  expect((await store.getSourceSyncRun(run.id))?.status).toBe("succeeded");
});

test("source_sync consumer does not terminalize or publish a snapshot after losing its lease", async () => {
  const { store, sourcesService, runner, controller } = build();
  const { source } = await sourcesService.createSource({
    workspaceId: "workspace_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
  });
  const { run } = await controller.createSourceSync(source.id);
  runner.onSourceSync = async () => {
    const current = await store.getSourceSyncRun(run.id);
    expect(current?.status).toBe("running");
    const stolen: SourceSyncRun = {
      ...(current as SourceSyncRun),
      status: "running",
      heartbeatAt: 50_000,
      updatedAt: "2026-06-06T00:00:50.000Z",
    };
    const takeover = await store.transitionRun({
      id: run.id,
      kind: "source_sync",
      expectFrom: ["running"],
      expectHeartbeatAt: current?.heartbeatAt ?? null,
      run: stolen,
      setLeaseToken: "lease_other_worker",
      heartbeatAt: 50_000,
    });
    expect(takeover.won).toBe(true);
  };

  await controller.runQueuedSourceSync(run.id);

  const current = await store.getSourceSyncRun(run.id);
  expect(current?.status).toBe("running");
  expect(current?.heartbeatAt).toBe(50_000);
  expect(await store.listSourceSnapshots(source.id)).toHaveLength(0);
  expect((await store.getSource(source.id))?.lastSeenCommit).toBeUndefined();
});
