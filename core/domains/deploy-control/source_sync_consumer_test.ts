import { expect, test } from "bun:test";

import {
  OpenTofuDeploymentController,
  type OpenTofuApplyJob,
  type OpenTofuPlanJob,
  type OpenTofuSourceSyncJob,
  type OpenTofuSourceSyncResult,
} from "./mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "./store.ts";
import { SourcesService } from "../sources/mod.ts";
import { StaticSecretConnectionVault } from "../../adapters/vault/mod.ts";
import { MultiCloudSecretBoundaryCrypto } from "../../adapters/secret-store/memory.ts";

class StubRunner {
  readonly calls: OpenTofuSourceSyncJob[] = [];
  result: OpenTofuSourceSyncResult = {
    resolvedCommit: "abc123def456",
    archiveDigest: "sha256:" + "a".repeat(64),
    archiveSizeBytes: 4096,
  };
  fail = false;

  plan(_job: OpenTofuPlanJob): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  apply(_job: OpenTofuApplyJob): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  sourceSync(job: OpenTofuSourceSyncJob): Promise<OpenTofuSourceSyncResult> {
    this.calls.push(job);
    if (this.fail) return Promise.reject(new Error("runner exploded"));
    return Promise.resolve(this.result);
  }
}

function build() {
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
    now: () => 1_000,
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
    spaceId: "space_1",
    sourceId: source.id,
    connectionId: conn.id,
    phase: "source",
    capabilities: ["source"],
  });
  expect(mintEvents[0]?.installationId).toBeUndefined();
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
