import { expect, test } from "bun:test";

import {
  OpenTofuDeploymentController,
  type OpenTofuApplyJob,
  type OpenTofuPlanJob,
  type OpenTofuSourceSyncJob,
  type OpenTofuSourceSyncResult,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import { StaticSecretConnectionVault } from "../../../../core/adapters/vault/mod.ts";
import { MultiCloudSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import type { SourceSyncRun } from "takosumi-contract/sources";

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
    return this.result;
  }
}

function build(
  options: {
    readonly now?: () => number;
    readonly runRenewalIntervalMs?: number;
  } = {},
) {
  const store = new InMemoryOpenTofuDeploymentStore();
  let counter = 0;
  const newId = (prefix: string) =>
    `${prefix}_test${(counter += 1).toString().padStart(8, "0")}`;
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new MultiCloudSecretBoundaryCrypto({
      globalPassphrase: "test-passphrase-0123456789-abcdef-0123456789",
    }),
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    newId: () => newId("conn"),
  });
  const sourcesService = new SourcesService({
    store,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    newId,
    newHookSecret: () => "whk_secret",
  });
  const runner = new StubRunner();
  const controller = new OpenTofuDeploymentController({
    store,
    vault,
    sourcesService,
    runner: runner as never,
    now: options.now ?? (() => 1_000),
    ...(options.runRenewalIntervalMs !== undefined
      ? { runRenewalIntervalMs: options.runRenewalIntervalMs }
      : {}),
  });
  return { store, vault, sourcesService, runner, controller };
}

test("source_sync consumer (public repo) records a snapshot and lastSeenCommit", async () => {
  const { store, sourcesService, runner, controller } = build();
  const { source } = await sourcesService.createSource({
    spaceId: "space_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
  });
  const { run } = await controller.createSourceSync(source.id);

  await controller.dispatchQueuedRun({
    action: "source_sync",
    runId: run.id,
    spaceId: "space_1",
  });

  // Public repo: no credentials were minted.
  expect(runner.calls).toHaveLength(1);
  expect(runner.calls[0].credentials).toBeUndefined();
  expect(runner.calls[0].archiveObjectKey).toBe(run.archiveObjectKey);

  const finished = await store.getSourceSyncRun(run.id);
  expect(finished?.status).toBe("succeeded");
  expect(finished?.resolvedCommit).toBe("abc123def456");
  expect(finished?.archiveDigest).toBe(runner.result.archiveDigest);

  const snapshots = await store.listSourceSnapshots(source.id);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0].resolvedCommit).toBe("abc123def456");
  expect(snapshots[0].archiveObjectKey).toBe(run.archiveObjectKey);

  const stored = await store.getSource(source.id);
  expect(stored?.lastSeenCommit).toBe("abc123def456");
  expect(await store.listCredentialMintEventsForRun(run.id)).toEqual([]);
});

test("source_sync consumer reuses an unchanged SourceSnapshot archive", async () => {
  const { store, sourcesService, runner, controller } = build();
  const { source } = await sourcesService.createSource({
    spaceId: "space_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
  });
  const previousArchiveKey =
    "spaces/space_1/sources/src_prev/snapshots/snap_prev/source.tar.zst";
  const previousDigest = "sha256:" + "b".repeat(64);
  await store.putSourceSnapshot({
    id: "snap_prev",
    origin: "git",
    workspaceId: "space_1",
    spaceId: "space_1",
    sourceId: source.id,
    url: "https://github.com/acme/repo.git",
    ref: "main",
    resolvedCommit: "abc123def456",
    path: ".",
    archiveObjectKey: previousArchiveKey,
    archiveDigest: previousDigest,
    archiveSizeBytes: 2048,
    fetchedByRunId: "ssr_prev",
    fetchedAt: "1970-01-01T00:00:00.000Z",
  });
  runner.onSourceSync = async (job) => {
    expect(job.reuseSnapshot).toEqual({
      id: "snap_prev",
      resolvedCommit: "abc123def456",
      archiveObjectKey: previousArchiveKey,
      archiveDigest: previousDigest,
      archiveSizeBytes: 2048,
    });
    runner.result = {
      resolvedCommit: job.reuseSnapshot!.resolvedCommit,
      archiveDigest: job.reuseSnapshot!.archiveDigest,
      archiveSizeBytes: job.reuseSnapshot!.archiveSizeBytes,
      archiveObjectKey: job.reuseSnapshot!.archiveObjectKey,
    };
  };
  const { run } = await controller.createSourceSync(source.id);

  await controller.dispatchQueuedRun({
    action: "source_sync",
    runId: run.id,
    spaceId: "space_1",
  });

  expect(runner.calls).toHaveLength(1);
  const finished = await store.getSourceSyncRun(run.id);
  expect(finished?.status).toBe("succeeded");
  expect(finished?.archiveDigest).toBe(previousDigest);
  const snapshots = await store.listSourceSnapshots(source.id);
  expect(snapshots).toHaveLength(2);
  const reused = snapshots.find((snapshot) => snapshot.fetchedByRunId === run.id);
  expect(reused?.archiveObjectKey).toBe(previousArchiveKey);
  expect(reused?.archiveDigest).toBe(previousDigest);
  expect(reused?.archiveSizeBytes).toBe(2048);
});

test("source_sync consumer reuses an unchanged public Git archive from a sibling Source in the same space", async () => {
  const { store, sourcesService, runner, controller } = build();
  const { source: firstSource } = await sourcesService.createSource({
    spaceId: "space_1",
    name: "repo-a",
    url: "https://github.com/acme/repo.git",
  });
  const { source: secondSource } = await sourcesService.createSource({
    spaceId: "space_1",
    name: "repo-b",
    url: "https://github.com/acme/repo.git",
  });
  const previousArchiveKey =
    "spaces/space_1/sources/src_prev/snapshots/snap_prev/source.tar.zst";
  const previousDigest = "sha256:" + "b".repeat(64);
  await store.putSourceSnapshot({
    id: "snap_prev",
    origin: "git",
    workspaceId: "space_1",
    spaceId: "space_1",
    sourceId: firstSource.id,
    url: "https://github.com/acme/repo.git",
    ref: "main",
    resolvedCommit: "abc123def456",
    path: ".",
    archiveObjectKey: previousArchiveKey,
    archiveDigest: previousDigest,
    archiveSizeBytes: 2048,
    fetchedByRunId: "ssr_prev",
    fetchedAt: "1970-01-01T00:00:00.000Z",
  });
  runner.onSourceSync = async (job) => {
    expect(job.reuseSnapshot).toEqual({
      id: "snap_prev",
      resolvedCommit: "abc123def456",
      archiveObjectKey: previousArchiveKey,
      archiveDigest: previousDigest,
      archiveSizeBytes: 2048,
    });
    runner.result = {
      resolvedCommit: job.reuseSnapshot!.resolvedCommit,
      archiveDigest: job.reuseSnapshot!.archiveDigest,
      archiveSizeBytes: job.reuseSnapshot!.archiveSizeBytes,
      archiveObjectKey: job.reuseSnapshot!.archiveObjectKey,
    };
  };
  const { run } = await controller.createSourceSync(secondSource.id);

  await controller.dispatchQueuedRun({
    action: "source_sync",
    runId: run.id,
    spaceId: "space_1",
  });

  const snapshots = await store.listSourceSnapshots(secondSource.id);
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.archiveObjectKey).toBe(previousArchiveKey);
  expect(snapshots[0]?.archiveDigest).toBe(previousDigest);
});

test("source_sync consumer does not reuse sibling Git archives across credential or space boundaries", async () => {
  const { store, sourcesService, vault, runner, controller } = build();
  const conn = await vault.register({
    spaceId: "space_1",
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
    spaceId: "space_1",
    name: "public",
    url: "https://github.com/acme/repo.git",
  });
  const { source: privateSource } = await sourcesService.createSource({
    spaceId: "space_1",
    name: "private",
    url: "https://github.com/acme/repo.git",
    authConnectionId: conn.id,
  });
  const otherSpaceStoreSource = {
    id: "src_other_space",
    workspaceId: "space_2",
    spaceId: "space_2",
    name: "repo-other-space",
    url: "https://github.com/acme/repo.git",
    defaultRef: "main",
    defaultPath: ".",
    status: "active" as const,
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    hookSecretHash: "hash",
    autoSync: false,
  };
  await store.putSource(otherSpaceStoreSource);
  await store.putSourceSnapshot({
    id: "snap_public",
    origin: "git",
    workspaceId: "space_1",
    spaceId: "space_1",
    sourceId: publicSource.id,
    url: "https://github.com/acme/repo.git",
    ref: "main",
    resolvedCommit: "abc123def456",
    path: ".",
    archiveObjectKey:
      "spaces/space_1/sources/src_public/snapshots/snap_public/source.tar.zst",
    archiveDigest: "sha256:" + "b".repeat(64),
    archiveSizeBytes: 2048,
    fetchedByRunId: "ssr_public",
    fetchedAt: "1970-01-01T00:00:00.000Z",
  });
  await store.putSourceSnapshot({
    id: "snap_other_space",
    origin: "git",
    workspaceId: "space_2",
    spaceId: "space_2",
    sourceId: otherSpaceStoreSource.id,
    url: "https://github.com/acme/repo.git",
    ref: "main",
    resolvedCommit: "abc123def456",
    path: ".",
    archiveObjectKey:
      "spaces/space_2/sources/src_other/snapshots/snap_other/source.tar.zst",
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
    spaceId: "space_1",
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
    spaceId: "space_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
  });
  await store.putSourceSnapshot({
    id: "snap_prev",
    origin: "git",
    workspaceId: "space_1",
    spaceId: "space_1",
    sourceId: source.id,
    url: "https://github.com/acme/repo.git",
    ref: "main",
    resolvedCommit: "abc123def456",
    path: ".",
    archiveObjectKey:
      "spaces/space_1/sources/src_prev/snapshots/snap_prev/source.tar.zst",
    archiveDigest: "sha256:" + "b".repeat(64),
    archiveSizeBytes: 2048,
    fetchedByRunId: "ssr_prev",
    fetchedAt: "1970-01-01T00:00:00.000Z",
  });
  runner.onSourceSync = async (job) => {
    runner.result = {
      resolvedCommit: job.reuseSnapshot!.resolvedCommit,
      archiveDigest: job.reuseSnapshot!.archiveDigest,
      archiveSizeBytes: job.reuseSnapshot!.archiveSizeBytes,
      archiveObjectKey:
        "spaces/other_space/sources/src_bad/snapshots/snap_bad/source.tar.zst",
    };
  };
  const { run } = await controller.createSourceSync(source.id);

  await controller.dispatchQueuedRun({
    action: "source_sync",
    runId: run.id,
    spaceId: "space_1",
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
    spaceId: "space_1",
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
    spaceId: "space_1",
    name: "repo",
    url: "https://github.com/acme/private.git",
    authConnectionId: conn.id,
  });
  const { run } = await controller.createSourceSync(source.id);
  await controller.dispatchQueuedRun({
    action: "source_sync",
    runId: run.id,
    spaceId: "space_1",
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
    workspaceId: "space_1",
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
    spaceId: "space_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
  });
  const { run } = await controller.createSourceSync(source.id);
  await controller.dispatchQueuedRun({
    action: "source_sync",
    runId: run.id,
    spaceId: "space_1",
  });
  const finished = await store.getSourceSyncRun(run.id);
  expect(finished?.status).toBe("failed");
  expect(finished?.error).toContain("runner exploded");
  expect(await store.listSourceSnapshots(source.id)).toHaveLength(0);
});

test("source_sync retry-exhausted backstop marks a queued run failed", async () => {
  const { store, sourcesService, controller } = build();
  const { source } = await sourcesService.createSource({
    spaceId: "space_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
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
    spaceId: "space_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
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
    spaceId: "space_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
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
    spaceId: "space_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
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
