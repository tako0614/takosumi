import { expect, test } from "bun:test";

import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import {
  ObjectKeyArtifactReferenceAllocator,
  type ArtifactReferenceAllocator,
} from "../../../../core/adapters/storage/artifact-references.ts";
import {
  InMemoryOpenTofuControlStore,
  WorkspaceManagementAdmissionConflictError,
  type TransitionRunInput,
  type TransitionRunResult,
  type StoredSource,
  type WorkspaceManagementAuthority,
  type WorkspaceManagement,
} from "../../../../core/domains/deploy-control/store.ts";
import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";
import type {
  ApplyRun,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";
import type { SourceSnapshot } from "takosumi-contract/sources";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class PausingArtifactReferenceAllocator
  implements ArtifactReferenceAllocator
{
  readonly delegate = new ObjectKeyArtifactReferenceAllocator();
  readonly started = deferred<void>();
  readonly release = deferred<void>();
  calls = 0;

  async allocate(input: Parameters<ArtifactReferenceAllocator["allocate"]>[0]) {
    this.calls += 1;
    this.started.resolve();
    await this.release.promise;
    return await this.delegate.allocate(input);
  }
}

class DrainBeforeStaleReplacementStore extends InMemoryOpenTofuControlStore {
  beforeStaleReplacement?: () => Promise<void>;

  override async transitionRun(
    input: TransitionRunInput,
  ): Promise<TransitionRunResult> {
    if (
      this.beforeStaleReplacement &&
      input.kind === "source_sync" &&
      input.expectedWorkspaceManagementAuthority !== undefined
    ) {
      const before = this.beforeStaleReplacement;
      this.beforeStaleReplacement = undefined;
      await before();
    }
    return await super.transitionRun(input);
  }
}

/**
 * Test-only management fixture that can model a drain/resume without exposing
 * a public resume API. The underlying in-memory store remains the durable row
 * authority for Run identity/lease state; this layer only changes the observed
 * Workspace management tuple and rejects/permits the same CAS boundaries that
 * a resumed durable adapter would enforce.
 */
class MutableWorkspaceManagementStore extends InMemoryOpenTofuControlStore {
  #management: WorkspaceManagement = {
    workspaceId: "workspace_1",
    managementState: "active",
    managementEpoch: 1,
  };
  storedAuthorityOverride?: WorkspaceManagementAuthority;

  setManagement(management: WorkspaceManagement): void {
    this.#management = { ...management };
  }

  override async getWorkspaceManagement(workspaceId: string) {
    if (workspaceId === this.#management.workspaceId) {
      return { ...this.#management };
    }
    return await super.getWorkspaceManagement(workspaceId);
  }

  override async getRunManagementAuthority(
    input: Parameters<InMemoryOpenTofuControlStore["getRunManagementAuthority"]>[0],
  ) {
    if (this.storedAuthorityOverride !== undefined) {
      return { ...this.storedAuthorityOverride };
    }
    return await super.getRunManagementAuthority(input);
  }

  override async beginSourceSyncRun(
    run: Parameters<InMemoryOpenTofuControlStore["beginSourceSyncRun"]>[0],
    expected?: Parameters<InMemoryOpenTofuControlStore["beginSourceSyncRun"]>[1],
  ) {
    // The base in-memory store starts at epoch 1. When a test models a resumed
    // epoch, adapt only the delegate's private fixture state so a new-row
    // admission can stand in for a durable adapter that has also resumed.
    if (
      expected !== undefined &&
      expected.workspaceId === this.#management.workspaceId &&
      expected.managementEpoch === this.#management.managementEpoch &&
      this.#management.managementState === "active"
    ) {
      return await super.beginSourceSyncRun(run, {
        ...expected,
        managementEpoch: 1,
      });
    }
    if (
      expected !== undefined &&
      expected.workspaceId === this.#management.workspaceId &&
      (expected.managementEpoch !== this.#management.managementEpoch ||
        this.#management.managementState !== "active")
    ) {
      throw new WorkspaceManagementAdmissionConflictError(run.workspaceId);
    }
    return await super.beginSourceSyncRun(run, expected);
  }

  override async transitionRun(
    input: TransitionRunInput,
  ): Promise<TransitionRunResult> {
    const expected = input.expectedWorkspaceManagementAuthority;
    if (expected !== undefined) {
      const current = await super.getSourceSyncRun(input.id);
      if (
        expected.workspaceId !== this.#management.workspaceId ||
        this.#management.managementState !== "active" ||
        expected.managementEpoch !== this.#management.managementEpoch
      ) {
        return { won: false, ...(current ? { run: current } : {}) };
      }
      if (input.requireStoredManagementAuthority === true) {
        const original = await super.getRunManagementAuthority({
          id: input.id,
          workspaceId: expected.workspaceId,
          kind: input.kind,
        });
        if (
          original === undefined ||
          original.workspaceId !== this.#management.workspaceId ||
          original.managementEpoch !== this.#management.managementEpoch
        ) {
          return { won: false, ...(current ? { run: current } : {}) };
        }
      }
      const {
        expectedWorkspaceManagementAuthority: _expected,
        requireStoredManagementAuthority: _requireStored,
        ...delegated
      } = input;
      return await super.transitionRun(delegated);
    }
    return await super.transitionRun(input);
  }
}

class SentinelSourceManagementReadStore extends InMemoryOpenTofuControlStore {
  throwOnRunManagementAuthorityRead = false;
  throwOnWorkspaceManagementRead = false;

  override async getRunManagementAuthority(
    input: Parameters<InMemoryOpenTofuControlStore["getRunManagementAuthority"]>[0],
  ) {
    if (this.throwOnRunManagementAuthorityRead) {
      throw new Error("sentinel run-management-authority read failure");
    }
    return await super.getRunManagementAuthority(input);
  }

  override async getWorkspaceManagement(workspaceId: string) {
    if (this.throwOnWorkspaceManagementRead) {
      throw new Error("sentinel workspace-management read failure");
    }
    return await super.getWorkspaceManagement(workspaceId);
  }
}

class BeginExistingSourceSyncStore extends MutableWorkspaceManagementStore {
  forcedExisting?: Parameters<InMemoryOpenTofuControlStore["beginSourceSyncRun"]>[0];

  override async beginSourceSyncRun(
    run: Parameters<InMemoryOpenTofuControlStore["beginSourceSyncRun"]>[0],
    expected?: Parameters<InMemoryOpenTofuControlStore["beginSourceSyncRun"]>[1],
  ) {
    const existing = this.forcedExisting;
    if (existing !== undefined) {
      this.forcedExisting = undefined;
      return { status: "existing" as const, run: existing };
    }
    return await super.beginSourceSyncRun(run, expected);
  }
}

class ReconciliationBarrierStore extends MutableWorkspaceManagementStore {
  readonly enumerationStarted = deferred<void>();
  readonly releaseEnumeration = deferred<void>();
  #pauseNextEnumeration = true;

  override async listCapsulesPage(
    workspaceId: string,
    params: Parameters<InMemoryOpenTofuControlStore["listCapsulesPage"]>[1],
  ) {
    if (this.#pauseNextEnumeration) {
      this.#pauseNextEnumeration = false;
      this.enumerationStarted.resolve();
      await this.releaseEnumeration.promise;
    }
    return await super.listCapsulesPage(workspaceId, params);
  }
}

class PausingConnectionLookupStore extends InMemoryOpenTofuControlStore {
  readonly connectionLookupStarted = deferred<void>();
  readonly releaseConnectionLookup = deferred<void>();
  #pauseNextConnectionLookup = false;

  pauseNextConnectionLookup(): void {
    this.#pauseNextConnectionLookup = true;
  }

  override async getConnection(id: string) {
    if (this.#pauseNextConnectionLookup) {
      this.#pauseNextConnectionLookup = false;
      this.connectionLookupStarted.resolve();
      await this.releaseConnectionLookup.promise;
    }
    return await super.getConnection(id);
  }
}

function makeService(
  overrides: {
    store?: InMemoryOpenTofuControlStore;
    artifactReferenceAllocator?: ArtifactReferenceAllocator;
    enqueueSourceSync?: (d: {
      action: "source_sync";
      runId: string;
      workspaceId: string;
      sourceId: string;
    }) => Promise<void>;
    readCapsuleSourceFiles?: (
      snapshot: SourceSnapshot,
      options?: { readonly modulePath?: string },
    ) => Promise<readonly { readonly path: string; readonly text: string }[]>;
  } = {},
) {
  const store = overrides.store ?? new InMemoryOpenTofuControlStore();
  // createSync now claims a source_sync Run through the Workspace management
  // admission fence; seed the fixture's owning Workspace before any Source
  // creation or dedupe/claim assertion.
  void store.putWorkspace({
    id: "workspace_1",
    handle: "workspace-1",
    displayName: "Workspace 1",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  let counter = 0;
  const service = new SourcesService({
    store,
    artifactReferenceAllocator:
      overrides.artifactReferenceAllocator ??
      new ObjectKeyArtifactReferenceAllocator(),
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    newId: (prefix) =>
      `${prefix}_test${(counter += 1).toString().padStart(8, "0")}`,
    newHookSecret: () => "whk_fixed_secret_value",
    ...(overrides.enqueueSourceSync
      ? { enqueueSourceSync: overrides.enqueueSourceSync }
      : {}),
    ...(overrides.readCapsuleSourceFiles
      ? { readCapsuleSourceFiles: overrides.readCapsuleSourceFiles }
      : {}),
  });
  return { store, service };
}

async function seedConnection(
  store: InMemoryOpenTofuControlStore,
  id: string,
  workspaceId: string,
): Promise<void> {
  const conn: ProviderConnection = {
    id,
    workspaceId,
    scope: "workspace",
    provider: "source_git_https_token",
    providerSource: "git",
    kind: "source_git_https_token",
    materialization: "secret",
    status: "pending",
    envNames: ["GIT_HTTPS_TOKEN"],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putConnection(conn);
}

test("createSource validates URL policy and stores status active", async () => {
  const { store, service } = makeService();
  const { source, hookSecret } = await service.createSource({
    workspaceId: "workspace_1",
    name: "my repo",
    url: "https://github.com/acme/repo.git",
  });
  expect(source.id).toMatch(/^src_/);
  expect(source.status).toBe("active");
  expect(source.defaultRef).toBe("HEAD");
  expect(source.defaultPath).toBe(".");
  expect(hookSecret).toBe("whk_fixed_secret_value");
  // The public source must NOT carry the hook secret hash or private fields.
  expect(JSON.stringify(source)).not.toContain("hookSecretHash");
  expect(source.autoSync).toBe(false);
  // The stored record carries the hash, not the plaintext secret.
  const stored = await store.getSource(source.id);
  expect(stored?.hookSecretHash).toBeDefined();
  expect(stored?.hookSecretHash).not.toBe(hookSecret);
  expect(stored?.autoSync).toBe(false);
});

test("createSource rejects a forbidden URL", async () => {
  const { service } = makeService();
  await expect(
    service.createSource({
      workspaceId: "workspace_1",
      name: "bad",
      url: "file:///etc/passwd",
    }),
  ).rejects.toThrow(/not allowed/);
});

test("createSource rejects blocked source hosts before source_sync", async () => {
  const blocked = [
    "https://127.0.0.1/repo.git",
    "https://10.0.0.10/repo.git",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/repo.git",
    "https://[fc00::1]/repo.git",
    "https://localhost/repo.git",
  ];
  for (const url of blocked) {
    const { service } = makeService();
    await expect(
      service.createSource({
        workspaceId: "workspace_1",
        name: "blocked",
        url,
      }),
    ).rejects.toThrow(/blocked_host/);
  }
});

test("createSource rejects an authConnectionId that is not in the Workspace", async () => {
  const { service } = makeService();
  await expect(
    service.createSource({
      workspaceId: "workspace_1",
      name: "x",
      url: "https://github.com/a/b",
      authConnectionId: "conn_missing",
    }),
  ).rejects.toThrow(/auth connection does not exist in this workspace/);
});

test("createSource accepts an authConnectionId present in the Workspace", async () => {
  const { store, service } = makeService();
  await seedConnection(store, "conn_git1", "workspace_1");
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "x",
    url: "https://github.com/a/b",
    authConnectionId: "conn_git1",
  });
  expect(source.authConnectionId).toBe("conn_git1");
});

test("createSource rejects a valid noncurrent Workspace management authority", async () => {
  const { store, service } = makeService();
  const expectedWorkspaceManagementAuthority: WorkspaceManagementAuthority = {
    workspaceId: "workspace_1",
    managementState: "active",
    managementEpoch: 2,
  };

  await expect(
    service.createSource(
      {
        workspaceId: "workspace_1",
        name: "noncurrent-authority",
        url: "https://github.com/acme/repo.git",
      },
      expectedWorkspaceManagementAuthority,
    ),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "workspace_management_admission_conflict" },
  });
  expect(await store.listSources("workspace_1")).toEqual([]);
});

test("listSources / getSource project public records only", async () => {
  const { service } = makeService();
  await service.createSource({
    workspaceId: "workspace_1",
    name: "a",
    url: "https://github.com/a/b",
    autoSync: true,
  });
  const list = await service.listSources("workspace_1");
  expect(list.sources).toHaveLength(1);
  expect(JSON.stringify(list.sources)).not.toContain("hookSecretHash");
  expect(list.sources[0]?.autoSync).toBe(true);
  const got = await service.getSource(list.sources[0].id);
  expect(got.source.id).toBe(list.sources[0].id);
  expect(got.source.autoSync).toBe(true);
});

test("patchSource updates fields, autoSync, and clears authConnectionId with null", async () => {
  const { store, service } = makeService();
  await seedConnection(store, "conn_git1", "workspace_1");
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "a",
    url: "https://github.com/a/b",
    authConnectionId: "conn_git1",
  });
  const patched = await service.patchSource(source.id, {
    name: "renamed",
    defaultRef: "release",
    status: "disabled",
    autoSync: true,
    authConnectionId: null,
  });
  expect(patched.source.name).toBe("renamed");
  expect(patched.source.defaultRef).toBe("release");
  expect(patched.source.status).toBe("disabled");
  expect(patched.source.autoSync).toBe(true);
  expect(patched.source.authConnectionId).toBeUndefined();
});

test("createSource rejects a drain raced during async auth validation", async () => {
  const store = new PausingConnectionLookupStore();
  const { service } = makeService({ store });
  await seedConnection(store, "conn_git1", "workspace_1");
  store.pauseNextConnectionLookup();

  const creating = service.createSource({
    workspaceId: "workspace_1",
    name: "raced-create",
    url: "https://github.com/acme/repo.git",
    authConnectionId: "conn_git1",
  });
  await store.connectionLookupStarted.promise;
  const management = await store.getWorkspaceManagement("workspace_1");
  await store.beginWorkspaceDraining("workspace_1", {
    workspaceId: "workspace_1",
    managementState: "active",
    managementEpoch: management!.managementEpoch,
  });
  store.releaseConnectionLookup.resolve();

  await expect(creating).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "workspace_management_admission_conflict" },
  });
  expect(await store.listSources("workspace_1")).toEqual([]);
});

test("patchSource rejects a drain raced during async auth validation", async () => {
  const store = new PausingConnectionLookupStore();
  const { service } = makeService({ store });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "raced-patch",
    url: "https://github.com/acme/repo.git",
  });
  await seedConnection(store, "conn_git1", "workspace_1");
  const before = await store.getSource(source.id);
  store.pauseNextConnectionLookup();

  const patching = service.patchSource(source.id, {
    authConnectionId: "conn_git1",
  });
  await store.connectionLookupStarted.promise;
  const management = await store.getWorkspaceManagement("workspace_1");
  await store.beginWorkspaceDraining("workspace_1", {
    workspaceId: "workspace_1",
    managementState: "active",
    managementEpoch: management!.managementEpoch,
  });
  store.releaseConnectionLookup.resolve();

  await expect(patching).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "workspace_management_admission_conflict" },
  });
  expect(await store.getSource(source.id)).toEqual(before);
});

test("createSync persists a queued run, allocates the archive ref, and enqueues", async () => {
  const dispatched: unknown[] = [];
  const { store, service } = makeService({
    enqueueSourceSync: async (d) => {
      dispatched.push(d);
    },
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "a",
    url: "https://github.com/a/b",
  });
  const { run } = await service.createSync(source.id);
  expect(run.status).toBe("queued");
  expect(run.kind).toBe("source_sync");
  expect(run.ref).toBe("HEAD");
  expect(run.archiveRef).toBe(
    `workspaces/workspace_1/sources/${source.id}/snapshots/${run.snapshotId!}/source.tar.zst`,
  );
  expect(dispatched).toEqual([
    {
      action: "source_sync",
      runId: run.id,
      workspaceId: "workspace_1",
      sourceId: source.id,
    },
  ]);
  const stored = await store.getSourceSyncRun(run.id);
  expect(stored?.id).toBe(run.id);
});

test("createSync rejects a valid noncurrent Workspace management authority", async () => {
  const dispatched: unknown[] = [];
  const { store, service } = makeService({
    enqueueSourceSync: async (dispatch) => {
      dispatched.push(dispatch);
    },
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "noncurrent-sync-authority",
    url: "https://github.com/acme/repo.git",
  });
  const expectedWorkspaceManagementAuthority: WorkspaceManagementAuthority = {
    workspaceId: "workspace_1",
    managementState: "active",
    managementEpoch: 2,
  };

  await expect(
    service.createSync(
      source.id,
      {},
      expectedWorkspaceManagementAuthority,
    ),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "workspace_management_admission_conflict" },
  });
  expect(await store.listSourceSyncRuns(source.id)).toEqual([]);
  expect(dispatched).toEqual([]);

  for (const options of [
    { dedupe: true },
    {
      intent: "manual_plan" as const,
      coordinator: {
        ref: "main", path: ".",
        runId: "ssr_noncurrentreplay", snapshotId: "snap_noncurrentreplay",
      },
    },
  ]) {
    const created = await service.createSync(source.id, options);
    const beforeReplay = [...dispatched];
    const replay = await service.createSync(source.id, options, expectedWorkspaceManagementAuthority);
    expect(replay.run).toEqual(created.run);
    expect(dispatched).toEqual(beforeReplay);
    expect(await store.getSourceSyncRun(created.run.id)).toEqual(created.run);
  }
});

test("createSync loses a drain race during preparation without creating or enqueueing a run", async () => {
  const allocator = new PausingArtifactReferenceAllocator();
  const dispatched: unknown[] = [];
  const { store, service } = makeService({
    artifactReferenceAllocator: allocator,
    enqueueSourceSync: async (dispatch) => {
      dispatched.push(dispatch);
    },
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "a",
    url: "https://github.com/a/b",
  });

  const creating = service.createSync(source.id);
  await allocator.started.promise;
  const management = await store.getWorkspaceManagement("workspace_1");
  expect(management).toMatchObject({
    workspaceId: "workspace_1",
    managementState: "active",
    managementEpoch: 1,
  });
  await store.beginWorkspaceDraining("workspace_1", {
    workspaceId: "workspace_1",
    managementState: "active",
    managementEpoch: management!.managementEpoch,
  });
  allocator.release.resolve();

  await expect(creating).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "workspace_management_admission_conflict" },
  });
  expect(allocator.calls).toBe(1);
  expect(dispatched).toEqual([]);
  expect(await store.listSourceSyncRuns(source.id)).toEqual([]);
});

test("createSync adopts an exact queued retry during drain without enqueueing or overwriting it", async () => {
  const allocator = new PausingArtifactReferenceAllocator();
  const dispatched: unknown[] = [];
  const { store, service } = makeService({
    artifactReferenceAllocator: allocator,
    enqueueSourceSync: async (dispatch) => {
      dispatched.push(dispatch);
    },
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "a",
    url: "https://github.com/a/b",
    defaultRef: "main",
  });
  const coordinator = {
    ref: "main",
    path: ".",
    runId: "ssr_exactdrain",
    snapshotId: "snap_exactdrain",
  } as const;
  const creating = service.createSync(source.id, {
    dedupe: true,
    intent: "manual_plan",
    coordinator,
  });
  await allocator.started.promise;
  const existing = {
    id: coordinator.runId,
    kind: "source_sync" as const,
    workspaceId: source.workspaceId,
    sourceId: source.id,
    url: source.url,
    ref: coordinator.ref,
    path: coordinator.path,
    archiveRef: `workspaces/${source.workspaceId}/sources/${source.id}/snapshots/${coordinator.snapshotId}/source.tar.zst`,
    intent: "manual_plan" as const,
    status: "queued" as const,
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    snapshotId: coordinator.snapshotId,
  };
  await store.putSourceSyncRun(existing);
  const management = await store.getWorkspaceManagement(source.workspaceId);
  await store.beginWorkspaceDraining(source.workspaceId, {
    workspaceId: source.workspaceId,
    managementState: "active",
    managementEpoch: management!.managementEpoch,
  });
  allocator.release.resolve();

  const replay = await creating;

  expect(replay.run).toEqual(existing);
  expect(await store.getSourceSyncRun(existing.id)).toEqual(existing);
  expect(dispatched).toEqual([]);
});

test("createSync dedupe returns and re-enqueues the existing queued run", async () => {
  const dispatched: unknown[] = [];
  const { service } = makeService({
    enqueueSourceSync: async (d) => {
      dispatched.push(d);
    },
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "a",
    url: "https://github.com/a/b",
  });
  const first = await service.createSync(source.id, { dedupe: true });
  const second = await service.createSync(source.id, { dedupe: true });
  expect(second.run.id).toBe(first.run.id);
  expect(dispatched).toEqual([
    {
      action: "source_sync",
      runId: first.run.id,
      workspaceId: "workspace_1",
      sourceId: source.id,
    },
    {
      action: "source_sync",
      runId: first.run.id,
      workspaceId: "workspace_1",
      sourceId: source.id,
    },
  ]);
});

test("createSync does not dedupe manual-plan refresh into an observe sync", async () => {
  const { service } = makeService();
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "a",
    url: "https://github.com/a/b",
  });
  const observe = await service.createSync(source.id, {
    dedupe: true,
    intent: "observe",
  });
  const manual = await service.createSync(source.id, {
    dedupe: true,
    intent: "manual_plan",
  });

  expect(observe.run.id).not.toBe(manual.run.id);
  expect(observe.run.intent).toBe("observe");
  expect(manual.run.intent).toBe("manual_plan");
});

test("createSync binds manual-plan dedupe to the expected immutable ref", async () => {
  const { service } = makeService();
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "a",
    url: "https://github.com/a/b",
  });
  const revision = "a".repeat(40);
  await service.patchSource(source.id, { defaultRef: revision });

  const first = await service.createSync(source.id, {
    dedupe: true,
    intent: "manual_plan",
    expectedRef: revision,
  });
  const second = await service.createSync(source.id, {
    dedupe: true,
    intent: "manual_plan",
    expectedRef: revision.toUpperCase(),
  });

  expect(second.run.id).toBe(first.run.id);
  expect(second.run.ref).toBe(revision);
});

test("createSync pins a coordinator-requested Git ref without mutating Source defaults", async () => {
  const { service } = makeService();
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "a",
    url: "https://github.com/a/b",
    defaultRef: "main",
    defaultPath: "deploy/app",
  });

  const first = await service.createSync(source.id, {
    dedupe: true,
    intent: "manual_plan",
    coordinator: {
      ref: "release/v2",
      path: "deploy/app",
      runId: "ssr_revisionexact",
      snapshotId: "snap_revisionexact",
    },
  });
  const replay = await service.createSync(source.id, {
    dedupe: true,
    intent: "manual_plan",
    coordinator: {
      ref: "release/v2",
      path: "deploy/app",
      runId: "ssr_revisionexact",
      snapshotId: "snap_revisionexact",
    },
  });

  expect(first.run).toMatchObject({
    sourceId: source.id,
    ref: "release/v2",
    path: "deploy/app",
    intent: "manual_plan",
  });
  expect(replay.run.id).toBe(first.run.id);
  expect((await service.getSource(source.id)).source).toMatchObject({
    defaultRef: "main",
    defaultPath: "deploy/app",
  });
});

test("createSync never adopts a semantically similar run for a coordinator identity", async () => {
  const { service } = makeService();
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "a",
    url: "https://github.com/a/b",
    defaultRef: "main",
    defaultPath: "deploy/app",
  });
  const ordinary = await service.createSync(source.id, {
    dedupe: true,
    intent: "manual_plan",
  });

  const coordinated = await service.createSync(source.id, {
    dedupe: true,
    intent: "manual_plan",
    coordinator: {
      ref: "main",
      path: "deploy/app",
      runId: "ssr_revisionseparate",
      snapshotId: "snap_revisionseparate",
    },
  });

  expect(coordinated.run.id).toBe("ssr_revisionseparate");
  expect(coordinated.run.snapshotId).toBe("snap_revisionseparate");
  expect(coordinated.run.id).not.toBe(ordinary.run.id);
});

test("createSync rejects a raced Source revision before creating a run", async () => {
  const { service } = makeService();
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "a",
    url: "https://github.com/a/b",
  });
  const requested = "a".repeat(40);
  const current = "b".repeat(40);
  await service.patchSource(source.id, { defaultRef: current });

  await expect(
    service.createSync(source.id, {
      dedupe: true,
      intent: "manual_plan",
      expectedRef: requested,
    }),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "source_revision_mismatch" },
  });
});

test("createSync dedupe does not re-enqueue a fresh running run", async () => {
  const dispatched: unknown[] = [];
  const { store, service } = makeService({
    enqueueSourceSync: async (d) => {
      dispatched.push(d);
    },
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "a",
    url: "https://github.com/a/b",
  });
  const first = await service.createSync(source.id, { dedupe: true });
  const heartbeatAt = new Date("2026-06-06T00:00:00.000Z").getTime();
  await store.transitionRun({
    id: first.run.id,
    kind: "source_sync",
    expectFrom: ["queued"],
    run: {
      ...first.run,
      status: "running",
      startedAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
      heartbeatAt,
    },
    setLeaseToken: "lease_running",
    heartbeatAt,
  });

  dispatched.length = 0;
  const second = await service.createSync(source.id, { dedupe: true });

  expect(second.run.id).toBe(first.run.id);
  expect(second.run.status).toBe("running");
  expect(dispatched).toEqual([]);
});

test("createSync dedupe replaces a stale running run with a fresh run", async () => {
  const dispatched: unknown[] = [];
  const { store, service } = makeService({
    enqueueSourceSync: async (d) => {
      dispatched.push(d);
    },
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "a",
    url: "https://github.com/a/b",
  });
  const first = await service.createSync(source.id, { dedupe: true });
  const heartbeatAt = new Date("2026-06-05T23:48:00.000Z").getTime();
  await store.transitionRun({
    id: first.run.id,
    kind: "source_sync",
    expectFrom: ["queued"],
    run: {
      ...first.run,
      status: "running",
      startedAt: "2026-06-05T23:48:00.000Z",
      updatedAt: "2026-06-05T23:48:00.000Z",
      heartbeatAt,
    },
    setLeaseToken: "lease_stale",
    heartbeatAt,
  });

  dispatched.length = 0;
  const second = await service.createSync(source.id, { dedupe: true });

  expect(second.run.id).not.toBe(first.run.id);
  expect(second.run.status).toBe("queued");
  const stale = await store.getSourceSyncRun(first.run.id);
  expect(stale?.status).toBe("failed");
  expect(stale?.error).toBe("stale_source_sync_replaced");
  expect(dispatched).toEqual([
    {
      action: "source_sync",
      runId: second.run.id,
      workspaceId: "workspace_1",
      sourceId: source.id,
    },
  ]);
});

test("createSync preserves a stale running run when drain wins the replacement race", async () => {
  const dispatched: unknown[] = [];
  const store = new DrainBeforeStaleReplacementStore();
  const { service } = makeService({
    store,
    enqueueSourceSync: async (dispatch) => {
      dispatched.push(dispatch);
    },
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "a",
    url: "https://github.com/a/b",
  });
  const first = await service.createSync(source.id, { dedupe: true });
  const heartbeatAt = new Date("2026-06-05T23:48:00.000Z").getTime();
  await store.transitionRun({
    id: first.run.id,
    kind: "source_sync",
    expectFrom: ["queued"],
    run: {
      ...first.run,
      status: "running",
      startedAt: "2026-06-05T23:48:00.000Z",
      updatedAt: "2026-06-05T23:48:00.000Z",
      heartbeatAt,
    },
    setLeaseToken: "lease_stale",
    heartbeatAt,
  });
  dispatched.length = 0;
  store.beforeStaleReplacement = async () => {
    const management = await store.getWorkspaceManagement(source.workspaceId);
    await store.beginWorkspaceDraining(source.workspaceId, {
      workspaceId: source.workspaceId,
      managementState: "active",
      managementEpoch: management!.managementEpoch,
    });
  };

  const replay = await service.createSync(source.id, { dedupe: true });

  expect(replay.run.id).toBe(first.run.id);
  expect(replay.run.status).toBe("running");
  expect(replay.run.error).toBeUndefined();
  expect(await store.getSourceSyncRun(first.run.id)).toEqual(replay.run);
  expect(dispatched).toEqual([]);
});

test("createSync does not replace an old-epoch running run after drain and resume", async () => {
  const dispatched: unknown[] = [];
  const store = new MutableWorkspaceManagementStore();
  const { service } = makeService({
    store,
    enqueueSourceSync: async (dispatch) => {
      dispatched.push(dispatch);
    },
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "old-epoch-running",
    url: "https://github.com/acme/repo.git",
  });
  const first = await service.createSync(source.id, { dedupe: true });
  const heartbeatAt = new Date("2026-06-05T23:48:00.000Z").getTime();
  const claimed = await store.transitionRun({
    id: first.run.id,
    kind: "source_sync",
    expectFrom: ["queued"],
    run: {
      ...first.run,
      status: "running",
      startedAt: "2026-06-05T23:48:00.000Z",
      updatedAt: "2026-06-05T23:48:00.000Z",
      heartbeatAt,
    },
    setLeaseToken: "lease_old_epoch",
    heartbeatAt,
  });
  expect(claimed.won).toBe(true);

  // Model the internal drain/resume transition. The old Run retains N=1 while
  // the current active Workspace is N+2=3.
  store.setManagement({
    workspaceId: source.workspaceId,
    managementState: "draining",
    managementEpoch: 2,
  });
  store.setManagement({
    workspaceId: source.workspaceId,
    managementState: "active",
    managementEpoch: 3,
  });
  dispatched.length = 0;

  const replay = await service.createSync(source.id, { dedupe: true });

  expect(replay.run).toEqual(claimed.run);
  expect(replay.run.status).toBe("running");
  expect(await store.listSourceSyncRuns(source.id)).toHaveLength(1);
  expect(await store.getSourceSyncRun(first.run.id)).toEqual(claimed.run);
  expect(dispatched).toEqual([]);
});

test("createSync re-enqueues only a queued run with the exact original active authority", async () => {
  const authority: WorkspaceManagementAuthority = {
    workspaceId: "workspace_1",
    managementState: "active",
    managementEpoch: 1,
  };

  // Same-epoch replay remains the existing queue repair path.
  {
    const dispatched: unknown[] = [];
    const store = new MutableWorkspaceManagementStore();
    const { service } = makeService({
      store,
      enqueueSourceSync: async (dispatch) => {
        dispatched.push(dispatch);
      },
    });
    const { source } = await service.createSource({
      workspaceId: "workspace_1",
      name: "same-epoch-queue",
      url: "https://github.com/acme/repo.git",
    });
    const first = await service.createSync(source.id, { dedupe: true });
    dispatched.length = 0;
    const replay = await service.createSync(source.id, { dedupe: true });
    expect(replay.run).toEqual(first.run);
    expect(dispatched).toHaveLength(1);
  }

  // An old row must not be re-enqueued after the Workspace resumes at N+2.
  {
    const dispatched: unknown[] = [];
    const store = new MutableWorkspaceManagementStore();
    const { service } = makeService({
      store,
      enqueueSourceSync: async (dispatch) => {
        dispatched.push(dispatch);
      },
    });
    const { source } = await service.createSource({
      workspaceId: "workspace_1",
      name: "old-epoch-queue",
      url: "https://github.com/acme/repo.git",
    });
    const first = await service.createSync(source.id, { dedupe: true });
    store.setManagement({
      workspaceId: source.workspaceId,
      managementState: "active",
      managementEpoch: 3,
    });
    dispatched.length = 0;
    const replay = await service.createSync(source.id, { dedupe: true });
    expect(replay.run).toEqual(first.run);
    expect(dispatched).toEqual([]);
  }

  // A pre-management legacy row remains observable but cannot gain authority.
  {
    const dispatched: unknown[] = [];
    const store = new MutableWorkspaceManagementStore();
    const { service } = makeService({
      store,
      enqueueSourceSync: async (dispatch) => {
        dispatched.push(dispatch);
      },
    });
    const { source } = await service.createSource({
      workspaceId: "workspace_1",
      name: "legacy-queue",
      url: "https://github.com/acme/repo.git",
    });
    const legacy = {
      id: "ssr_legacy_queue",
      kind: "source_sync" as const,
      workspaceId: source.workspaceId,
      sourceId: source.id,
      url: source.url,
      ref: source.defaultRef,
      path: source.defaultPath,
      archiveRef: "workspaces/workspace_1/sources/legacy/source.tar.zst",
      status: "queued" as const,
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    await store.putSourceSyncRun(legacy);
    const replay = await service.createSync(source.id, { dedupe: true });
    expect(replay.run).toEqual(legacy);
    expect(dispatched).toEqual([]);
  }

  // Even an explicitly supplied stale tuple cannot authorize repair of a row
  // whose persisted authority belongs to a different active epoch.
  {
    const dispatched: unknown[] = [];
    const store = new MutableWorkspaceManagementStore();
    const { service } = makeService({
      store,
      enqueueSourceSync: async (dispatch) => {
        dispatched.push(dispatch);
      },
    });
    const { source } = await service.createSource({
      workspaceId: "workspace_1",
      name: "explicit-stale-queue",
      url: "https://github.com/acme/repo.git",
    });
    const first = await service.createSync(source.id, { dedupe: true });
    store.storedAuthorityOverride = {
      ...authority,
      managementEpoch: 99,
    };
    dispatched.length = 0;
    const replay = await service.createSync(
      source.id,
      { dedupe: true },
      authority,
    );
    expect(replay.run).toEqual(first.run);
    expect(dispatched).toEqual([]);
  }
});

test("coordinator and begin-existing queue repairs require the original authority", async () => {
  const dispatched: unknown[] = [];
  const store = new BeginExistingSourceSyncStore();
  const { service } = makeService({
    store,
    enqueueSourceSync: async (dispatch) => {
      dispatched.push(dispatch);
    },
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "coordinator-epoch",
    url: "https://github.com/acme/repo.git",
  });
  const coordinator = {
    ref: source.defaultRef,
    path: source.defaultPath,
    runId: "ssr_coordinatorEpoch",
    snapshotId: "snap_coordinatorEpoch",
  } as const;
  const coordinated = await service.createSync(source.id, {
    intent: "manual_plan",
    dedupe: true,
    coordinator,
  });
  store.setManagement({
    workspaceId: source.workspaceId,
    managementState: "active",
    managementEpoch: 3,
  });
  dispatched.length = 0;
  const coordinatorReplay = await service.createSync(source.id, {
    intent: "manual_plan",
    dedupe: true,
    coordinator,
  });
  expect(coordinatorReplay.run).toEqual(coordinated.run);
  expect(dispatched).toEqual([]);

  const beginExisting = await service.createSync(source.id);
  store.forcedExisting = beginExisting.run;
  dispatched.length = 0;
  const raced = await service.createSync(source.id);
  expect(raced.run).toEqual(beginExisting.run);
  expect(dispatched).toEqual([]);
});

test("createSync propagates unknown management reads instead of treating them as legacy", async () => {
  const dispatched: unknown[] = [];

  // The durable authority getter returns undefined for a missing/malformed
  // legacy tuple. An unrelated adapter/SQL failure must still reach callers.
  {
    const store = new SentinelSourceManagementReadStore();
    const { service } = makeService({
      store,
      enqueueSourceSync: async (dispatch) => {
        dispatched.push(dispatch);
      },
    });
    const { source } = await service.createSource({
      workspaceId: "workspace_1",
      name: "sentinel-run-authority",
      url: "https://github.com/acme/repo.git",
    });
    await service.createSync(source.id, { dedupe: true });
    dispatched.length = 0;
    store.throwOnRunManagementAuthorityRead = true;

    await expect(
      service.createSync(source.id, { dedupe: true }),
    ).rejects.toThrow("sentinel run-management-authority read failure");
    expect(dispatched).toEqual([]);
  }

  // Supplying the already-captured tuple bypasses the initial capture read so
  // this exercises the helper's current-management read specifically.
  {
    const store = new SentinelSourceManagementReadStore();
    const { service } = makeService({
      store,
      enqueueSourceSync: async (dispatch) => {
        dispatched.push(dispatch);
      },
    });
    const { source } = await service.createSource({
      workspaceId: "workspace_1",
      name: "sentinel-workspace-management",
      url: "https://github.com/acme/repo.git",
    });
    await service.createSync(source.id, { dedupe: true });
    dispatched.length = 0;
    store.throwOnWorkspaceManagementRead = true;

    await expect(
      service.createSync(
        source.id,
        { dedupe: true },
        {
          workspaceId: source.workspaceId,
          managementState: "active",
          managementEpoch: 1,
        },
      ),
    ).rejects.toThrow("sentinel workspace-management read failure");
    expect(dispatched).toEqual([]);
  }
});

test("reconciliation keeps one captured authority across default and adopted lanes", async () => {
  const dispatched: unknown[] = [];
  const store = new ReconciliationBarrierStore();
  const { service } = makeService({
    store,
    enqueueSourceSync: async (dispatch) => {
      dispatched.push(dispatch);
    },
  });
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "workspace_1",
    sourceId: "src_reconciliation",
    capsuleId: "cap_reconciliation",
    snapshotId: "snap_reconciliation_default",
    ref: "main",
  });
  const adoptedSnapshot: SourceSnapshot = {
    ...seeded.snapshot,
    id: "snap_reconciliation_adopted",
    ref: "release",
    path: "infra",
    resolvedCommit: "bcdef0123456789abcdef0123456789abcdef012",
    archiveRef:
      "workspaces/workspace_1/sources/src_reconciliation/snapshots/snap_reconciliation_adopted/source.tar.zst",
    fetchedByRunId: "run_reconciliation_adopted",
  };
  await store.putSourceSnapshot(adoptedSnapshot);

  const plan: PlanRun = {
    id: "plan_reconciliation_adopted",
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    capsuleCurrentStateVersionId: null,
    source: {
      kind: "git",
      url: seeded.source.url,
      commit: adoptedSnapshot.resolvedCommit,
    },
    sourceDigest: "sha256:reconciliation-source",
    operation: "create",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:reconciliation-variables",
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:reconciliation-policy",
    planDigest: "sha256:reconciliation-plan",
    sourceSnapshotId: adoptedSnapshot.id,
    appliedApplyRunId: "apply_reconciliation_adopted",
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const apply: ApplyRun = {
    id: "apply_reconciliation_adopted",
    planRunId: plan.id,
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    stateVersionId: "state_reconciliation_adopted",
    operation: "create",
    runnerProfileId: plan.runnerProfileId,
    status: "succeeded",
    expected: {
      planRunId: plan.id,
      capsuleId: seeded.capsule.id,
      currentStateVersionId: null,
      runnerProfileId: plan.runnerProfileId,
      sourceDigest: plan.sourceDigest,
      variablesDigest: plan.variablesDigest,
      policyDecisionDigest: plan.policyDecisionDigest,
      planDigest: plan.planDigest!,
      planArtifactDigest: "sha256:reconciliation-artifact",
    },
    stateBackend: { kind: "operator-managed", ref: "state://reconciliation" },
    stateLock: {
      status: "recorded",
      backendRef: "state://reconciliation",
    },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.putPlanRun(plan);
  await store.putApplyRun(apply);
  await store.putStateVersion({
    id: apply.stateVersionId!,
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    generation: 1,
    stateRef: "state://reconciliation/1",
    digest: "sha256:reconciliation-state",
    createdByRunId: apply.id,
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putCapsule({
    ...seeded.capsule,
    currentStateVersionId: apply.stateVersionId,
    currentStateGeneration: 1,
    status: "active",
  });

  const reconciling = service.createReconciliationSyncs(seeded.source.id);
  await store.enumerationStarted.promise;
  expect(await store.getWorkspaceManagement(seeded.workspace.id)).toEqual({
    workspaceId: seeded.workspace.id,
    managementState: "active",
    managementEpoch: 1,
  });
  // The asynchronous lane enumeration loses the original authority before any
  // SourceSync row can be admitted.
  store.setManagement({
    workspaceId: seeded.workspace.id,
    managementState: "draining",
    managementEpoch: 2,
  });
  store.setManagement({
    workspaceId: seeded.workspace.id,
    managementState: "active",
    managementEpoch: 3,
  });
  store.releaseEnumeration.resolve();

  await expect(reconciling).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "workspace_management_admission_conflict" },
  });
  expect(await store.listSourceSyncRuns(seeded.source.id)).toEqual([]);
  expect(dispatched).toEqual([]);
});

test("verifyHookSecret accepts the right bearer and rejects others", async () => {
  const { service } = makeService();
  const { source, hookSecret } = await service.createSource({
    workspaceId: "workspace_1",
    name: "a",
    url: "https://github.com/a/b",
  });
  expect(await service.verifyHookSecret(source.id, hookSecret)).toBe(true);
  expect(await service.verifyHookSecret(source.id, "wrong")).toBe(false);
  expect(await service.verifyHookSecret("src_missing", hookSecret)).toBe(false);
  expect(await service.verifyHookSecret(source.id, "")).toBe(false);
});

test("listAutoSyncSources returns only active autoSync sources, capped", async () => {
  const { store, service } = makeService();
  // Seed three sources: one active+autoSync, one active without autoSync, one
  // disabled+autoSync.
  const seed = async (
    id: string,
    status: StoredSource["status"],
    autoSync: boolean,
    defaultRef = "main",
    lastSeenCommit?: string,
  ) => {
    await store.putSource({
      id,
      workspaceId: "workspace_1",
      name: id,
      url: "https://github.com/a/b",
      defaultRef,
      defaultPath: ".",
      status,
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
      hookSecretHash: "deadbeef",
      autoSync,
      ...(lastSeenCommit ? { lastSeenCommit } : {}),
    });
  };
  await seed("src_a", "active", true);
  await seed("src_b", "active", false);
  await seed("src_c", "disabled", true);
  await seed("src_d", "active", true, "a".repeat(40));
  await seed("src_e", "active", true, "b".repeat(40), "b".repeat(40));
  await seed("src_f", "active", true, "C".repeat(40), "c".repeat(40));
  await seed("src_g", "active", true, "d".repeat(40), "e".repeat(40));
  const scanned = await service.listAutoSyncSources(50);
  expect(scanned.map((s) => s.id)).toEqual(["src_a", "src_d", "src_g"]);
  expect((await service.listAutoSyncSources(0)).length).toBe(0);
});

test("listAutoSyncSourcesPage stays bounded while advancing across sparse rows", async () => {
  const { store, service } = makeService();
  const seed = async (
    id: string,
    workspaceId: string,
    status: StoredSource["status"],
    autoSync: boolean,
    defaultRef = "main",
    lastSeenCommit?: string,
  ) => {
    await store.putSource({
      id,
      workspaceId,
      name: id,
      url: "https://github.com/a/b",
      defaultRef,
      defaultPath: ".",
      status,
      createdAt: `2026-06-06T00:00:00.00${id.at(-1)}Z`,
      updatedAt: "2026-06-06T00:00:00.000Z",
      hookSecretHash: "deadbeef",
      autoSync,
      ...(lastSeenCommit ? { lastSeenCommit } : {}),
    });
  };
  await seed(
    "src_a1",
    "workspace_1",
    "active",
    true,
    "b".repeat(40),
    "b".repeat(40),
  );
  await seed("src_a2", "workspace_1", "active", true);
  await seed("src_b3", "workspace_2", "disabled", true);
  await seed("src_b4", "workspace_2", "active", true);

  const first = await service.listAutoSyncSourcesPage({ limit: 2 });
  const second = await service.listAutoSyncSourcesPage({
    limit: 2,
    cursor: first.nextCursor,
  });

  expect(first.items.map((source) => source.id)).toEqual(["src_a2"]);
  expect(first.nextCursor).toBeDefined();
  expect(second.items.map((source) => source.id)).toEqual(["src_b4"]);
  expect(second.nextCursor).toBeUndefined();
});

test("createCompatibilityCheck preserves the immutable source instead of rewriting HCL", async () => {
  const { store, service } = makeService({
    readCapsuleSourceFiles: async () => [
      {
        path: "main.tf",
        text: `
terraform {
  backend "s3" {}
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

provider "cloudflare" {
  alias = "zone"
}

output "public_url" {
  value = "https://example.com"
}
`,
      },
    ],
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "capsule",
    url: "https://github.com/acme/capsule.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    origin: "git",
    workspaceId: source.workspaceId,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveRef: run.archiveRef,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });

  const { report, run: compatibilityResponseRun } =
    await service.createCompatibilityCheck(source.id, {
      sourceSnapshotId: run.snapshotId,
    });

  expect(report.level).toBe("ready");
  expect(report).not.toHaveProperty("normalizedObjectKey");
  expect(report).not.toHaveProperty("normalizedDigest");
  const compatibilityRun =
    await store.getCompatibilityCheckRun("ccr_test00000004");
  expect(compatibilityRun).toMatchObject({
    id: "ccr_test00000004",
    workspaceId: "workspace_1",
    sourceId: source.id,
    type: "compatibility_check",
    status: "succeeded",
    sourceSnapshotId: run.snapshotId,
    compatibilityReportId: report.id,
    createdBy: "system",
  });
  expect(compatibilityResponseRun).toEqual(compatibilityRun);
});

test("createCompatibilityCheck applies Capsule policy to Gate severity", async () => {
  const observedOptions: unknown[] = [];
  const { store, service } = makeService({
    readCapsuleSourceFiles: async (_snapshot, options) => {
      observedOptions.push(options);
      return [
        {
          path: "main.tf",
          text: `
terraform {
  required_providers {
    custom = {
      source = "custom/provider"
    }
  }
}

resource "custom_resource" "ok" {}

data "external" "ok" {
  program = ["echo", "{}"]
}

resource "null_resource" "setup" {
  provisioner "local-exec" {
    command = "true"
  }
}

output "public_url" {
  value = "https://example.com"
}
`,
        },
      ];
    },
  });
  await store.putWorkspace({
    id: "workspace_1",
    handle: "workspace",
    displayName: "Workspace",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "policy-capsule",
    url: "https://github.com/acme/policy-capsule.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    origin: "git",
    workspaceId: source.workspaceId,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveRef: run.archiveRef,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putInstallConfig({
    id: "cfg_policy",
    name: "policy",
    modulePath: "deploy/opentofu",
    variableMapping: {},
    outputAllowlist: {},
    policy: {
      allowedProviders: [
        "registry.opentofu.org/custom/provider",
        "registry.opentofu.org/hashicorp/external",
        "registry.opentofu.org/hashicorp/null",
      ],
      allowedResourceTypes: ["custom_resource", "null_resource"],
      allowedDataSourceTypes: ["external"],
      allowedProvisionerTypes: ["local-exec"],
    },
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putCapsule({
    id: "capsule_policy",
    workspaceId: "workspace_1",
    projectId: "project_policy",
    name: "policy",
    slug: "policy",
    sourceId: source.id,
    installConfigId: "cfg_policy",
    environment: "preview",
    currentStateGeneration: 0,
    status: "pending",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });

  const { report } = await service.createCompatibilityCheck(source.id, {
    sourceSnapshotId: run.snapshotId,
    capsuleId: "capsule_policy",
  });

  expect(observedOptions).toEqual([
    {
      modulePath: "deploy/opentofu",
      runId: "ccr_test00000004",
    },
  ]);
  expect(report.level).toBe("ready");
  expect(report.findings).toEqual([]);
  expect(report.providerPackages[0]).toMatchObject({ allowed: true });
  expect(report.resources.every((resource) => resource.allowed)).toBe(true);
  expect(report.dataSources).toEqual([{ type: "external", allowed: true }]);
  expect(report.provisioners).toEqual([{ type: "local-exec", allowed: true }]);
});

test("createCompatibilityCheck applies a curated explicit allowlist without changing unset policy", async () => {
  // The Store deep-link may narrow execution with an InstallConfig, but generic
  // Core has no vendor resource catalog when policy is unset.
  const curatedHcl = `
terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

resource "cloudflare_dns_record" "this" {
  zone_id = var.zoneId
  name    = var.recordName
  type    = "CNAME"
  content = var.recordContent
}

output "url" {
  value = "https://example.com"
}
`;
  const { store, service } = makeService({
    readCapsuleSourceFiles: async () => [{ path: "main.tf", text: curatedHcl }],
  });
  await store.putWorkspace({
    id: "workspace_1",
    handle: "workspace",
    displayName: "Workspace",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "dns-capsule",
    url: "https://github.com/acme/dns-capsule.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    origin: "git",
    workspaceId: source.workspaceId,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveRef: run.archiveRef,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });
  // A built-in `official` InstallConfig has no workspaceId and is usable from any
  // Workspace; its policy is the BOUNDED minimal allowlist for this module only.
  await store.putInstallConfig({
    id: "cfg-official-dns-capsule",
    name: "dns-capsule",
    variableMapping: {},
    outputAllowlist: {},
    policy: {
      allowedProviders: ["cloudflare/cloudflare"],
      allowedResourceTypes: ["cloudflare_dns_record"],
    },
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });

  // Unset policy follows the provider-neutral OpenTofu path.
  const baseline = await service.createCompatibilityCheck(source.id, {
    sourceSnapshotId: run.snapshotId,
  });
  expect(baseline.report.level).toBe("ready");
  expect(
    baseline.report.findings.some(
      (f) => f.code === "resource_type_not_allowed",
    ),
  ).toBe(false);

  // The curated config explicitly permits only the provider/resource it owns.
  const curated = await service.createCompatibilityCheck(source.id, {
    sourceSnapshotId: run.snapshotId,
    installConfigId: "cfg-official-dns-capsule",
  });
  expect(curated.report.level).toBe("ready");
  expect(curated.report.resources.every((resource) => resource.allowed)).toBe(
    true,
  );
  expect(
    curated.report.findings.some((f) => f.code === "resource_type_not_allowed"),
  ).toBe(false);
});

test("createCompatibilityCheck rejects a curated installConfig from another Workspace", async () => {
  const { store, service } = makeService({
    readCapsuleSourceFiles: async () => [
      { path: "main.tf", text: 'output "x" { value = "y" }' },
    ],
  });
  await store.putWorkspace({
    id: "workspace_1",
    handle: "workspace",
    displayName: "Workspace",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "capsule",
    url: "https://github.com/acme/capsule.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    origin: "git",
    workspaceId: source.workspaceId,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveRef: run.archiveRef,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });
  // A Workspace-scoped config owned by a DIFFERENT Workspace must not be
  // borrowable to gate another Workspace's check.
  await store.putInstallConfig({
    id: "cfg_other_workspace",
    workspaceId: "workspace_2",
    name: "other",
    variableMapping: {},
    outputAllowlist: {},
    policy: { allowedResourceTypes: ["cloudflare_pages_project"] },
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  await expect(
    service.createCompatibilityCheck(source.id, {
      sourceSnapshotId: run.snapshotId,
      installConfigId: "cfg_other_workspace",
    }),
  ).rejects.toThrow(/install config is not available to this workspace/);
});

test("createCompatibilityCheck rejects a Capsule from another Workspace", async () => {
  const { store, service } = makeService();
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "capsule",
    url: "https://github.com/acme/capsule.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    origin: "git",
    workspaceId: source.workspaceId,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveRef: run.archiveRef,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putCapsule({
    id: "capsule_foreign",
    workspaceId: "workspace_2",
    projectId: "project_foreign",
    name: "foreign",
    slug: "foreign",
    sourceId: source.id,
    installConfigId: "cfg_foreign",
    environment: "preview",
    currentStateGeneration: 0,
    status: "pending",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });

  await expect(
    service.createCompatibilityCheck(source.id, {
      sourceSnapshotId: run.snapshotId,
      capsuleId: "capsule_foreign",
    }),
  ).rejects.toThrow(/capsule is not available to this source workspace/);
});

test("createCompatibilityCheck rejects a Capsule for another source", async () => {
  const { store, service } = makeService();
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "capsule",
    url: "https://github.com/acme/capsule.git",
  });
  const { source: otherSource } = await service.createSource({
    workspaceId: "workspace_1",
    name: "other",
    url: "https://github.com/acme/other.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    origin: "git",
    workspaceId: source.workspaceId,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveRef: run.archiveRef,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putCapsule({
    id: "capsule_other_source",
    workspaceId: "workspace_1",
    projectId: "project_other_source",
    name: "other",
    slug: "other",
    sourceId: otherSource.id,
    installConfigId: "cfg_other_source",
    environment: "preview",
    currentStateGeneration: 0,
    status: "pending",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });

  await expect(
    service.createCompatibilityCheck(source.id, {
      sourceSnapshotId: run.snapshotId,
      capsuleId: "capsule_other_source",
    }),
  ).rejects.toThrow(/does not use source/);
});

// After the credential-model collapse the standalone Provider Catalog (and its
// per-provider `ownershipOptions` enrichment) is removed. A Capsule's required
// providers are discovered straight from its source HCL, and every qualified
// source follows the same OpenTofu path. Credential needs are informational.
test("createCompatibilityCheck discovers required providers from Capsule source", async () => {
  const { store, service } = makeService({
    readCapsuleSourceFiles: async () => [
      {
        path: "main.tf",
        text: `
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
    vercel = {
      source = "vercel/vercel"
    }
    draft = {
      source = "draft/provider"
    }
  }
}

resource "aws_s3_bucket" "attachments" {
  bucket = "attachments"
}

output "public_url" {
  value = "https://example.com"
}
`,
      },
    ],
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "providers",
    url: "https://github.com/acme/providers.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    origin: "git",
    workspaceId: source.workspaceId,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveRef: run.archiveRef,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });

  const { report } = await service.createCompatibilityCheck(source.id, {
    sourceSnapshotId: run.snapshotId,
  });

  const providerBySource = new Map(
    report.providerPackages.map((provider) => [provider.source, provider]),
  );
  expect(
    providerBySource.get("registry.opentofu.org/hashicorp/aws")?.allowed,
  ).toBe(true);
  expect(
    providerBySource.get("registry.opentofu.org/vercel/vercel")?.allowed,
  ).toBe(true);
  expect(
    providerBySource.get("registry.opentofu.org/draft/provider")?.allowed,
  ).toBe(true);

  expect(report.findings).toEqual([]);
});

test("createCompatibilityCheck returns an unsupported report when analysis fails", async () => {
  const { store, service } = makeService({
    readCapsuleSourceFiles: async () => {
      throw new Error("runner unavailable");
    },
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "capsule",
    url: "https://github.com/acme/capsule.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    origin: "git",
    workspaceId: source.workspaceId,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveRef: run.archiveRef,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });

  const checked = await service.createCompatibilityCheck(source.id, {
    sourceSnapshotId: run.snapshotId,
  });
  expect(checked.report).toMatchObject({
    id: "caprep_test00000005",
    sourceId: source.id,
    sourceSnapshotId: run.snapshotId,
    level: "unsupported",
    providerPackages: [],
    rootProviderRequirements: [],
    resources: [],
    dataSources: [],
    provisioners: [],
  });
  expect(checked.report).not.toHaveProperty("normalizedObjectKey");
  expect(checked.report).not.toHaveProperty("normalizedDigest");
  expect(checked.report.findings).toEqual([
    expect.objectContaining({
      severity: "error",
      code: "capsule_compatibility_check_failed",
      message: "Takosumi could not inspect this Capsule before installation.",
      suggestion:
        "Retry the check after source sync finishes. If it still fails, ask the operator to inspect the compatibility_check runner.",
    }),
  ]);

  const compatibilityRun =
    await store.getCompatibilityCheckRun("ccr_test00000004");
  expect(compatibilityRun).toMatchObject({
    id: "ccr_test00000004",
    workspaceId: "workspace_1",
    sourceId: source.id,
    type: "compatibility_check",
    status: "failed",
    sourceSnapshotId: run.snapshotId,
    compatibilityReportId: "caprep_test00000005",
    createdBy: "system",
  });
  expect(compatibilityRun?.errorCode).toBe(
    "capsule_compatibility_check_failed",
  );
});

test("createCompatibilityCheck preserves archive-relative module paths", async () => {
  const observedOptions: unknown[] = [];
  const { store, service } = makeService({
    readCapsuleSourceFiles: async (_snapshot, options) => {
      observedOptions.push(options);
      return [
        {
          path: "main.tf",
          text: `
terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

resource "cloudflare_d1_database" "db" {
  account_id = var.account_id
  name       = "db"
}

output "url" {
  value = "https://example.com"
}
`,
        },
      ];
    },
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "takos",
    url: "https://github.com/tako0614/takos.git",
    defaultPath: "deploy/opentofu",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    origin: "git",
    workspaceId: source.workspaceId,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: "deploy/opentofu",
    archiveRef: run.archiveRef,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });

  const { report } = await service.createCompatibilityCheck(source.id, {
    sourceSnapshotId: run.snapshotId,
    modulePath: "deploy/opentofu",
  });

  expect(observedOptions).toEqual([
    { modulePath: "deploy/opentofu", runId: "ccr_test00000004" },
  ]);
  expect(report.level).toBe("ready");
  expect(report.findings).toEqual([]);
});

test("createCompatibilityCheck defaults to supplied InstallConfig modulePath", async () => {
  const observedOptions: unknown[] = [];
  const { store, service } = makeService({
    readCapsuleSourceFiles: async (_snapshot, options) => {
      observedOptions.push(options);
      return [
        {
          path: "main.tf",
          text: `
terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

resource "cloudflare_d1_database" "db" {
  account_id = var.account_id
  name       = "db"
}

output "url" {
  value = "https://example.com"
}
`,
        },
      ];
    },
  });
  await store.putInstallConfig({
    id: "cfg-git-takos",
    name: "takos",
    modulePath: "deploy/opentofu",
    variableMapping: {},
    outputAllowlist: {},
    policy: {
      allowedProviders: ["cloudflare/cloudflare"],
      allowedResourceTypes: ["cloudflare_d1_database"],
    },
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "takos",
    url: "https://github.com/tako0614/takos.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    origin: "git",
    workspaceId: source.workspaceId,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveRef: run.archiveRef,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });

  const { report } = await service.createCompatibilityCheck(source.id, {
    sourceSnapshotId: run.snapshotId,
    installConfigId: "cfg-git-takos",
  });

  expect(observedOptions).toEqual([
    { modulePath: "deploy/opentofu", runId: "ccr_test00000004" },
  ]);
  expect(report.level).toBe("ready");
  expect(report.findings).toEqual([]);
  expect(report.modulePath).toBe("deploy/opentofu");
});

test("createCompatibilityCheck pins a Capsule-scoped check to the Capsule's own module path", async () => {
  // A Capsule plans its own InstallConfig module path, so a caller-supplied
  // path must not be able to produce a Capsule-scoped report that describes a
  // different module than the one the Capsule will actually execute.
  const observedOptions: unknown[] = [];
  const { store, service } = makeService({
    readCapsuleSourceFiles: async (_snapshot, options) => {
      observedOptions.push(options);
      return [
        {
          path: "main.tf",
          text: `
output "url" {
  value = "https://example.com"
}
`,
        },
      ];
    },
  });
  await store.putInstallConfig({
    id: "cfg_capsule_module",
    name: "capsule",
    modulePath: "deploy/opentofu",
    variableMapping: {},
    outputAllowlist: {},
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const { source } = await service.createSource({
    workspaceId: "workspace_1",
    name: "capsule",
    url: "https://github.com/acme/capsule.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    origin: "git",
    workspaceId: source.workspaceId,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveRef: run.archiveRef,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putCapsule({
    id: "capsule_module_path",
    workspaceId: "workspace_1",
    projectId: "project_module_path",
    name: "capsule",
    slug: "capsule",
    sourceId: source.id,
    installConfigId: "cfg_capsule_module",
    environment: "preview",
    currentStateGeneration: 0,
    status: "pending",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });

  const { report } = await service.createCompatibilityCheck(source.id, {
    sourceSnapshotId: run.snapshotId,
    capsuleId: "capsule_module_path",
    modulePath: "examples/hello",
  });

  expect(observedOptions).toEqual([
    { modulePath: "deploy/opentofu", runId: "ccr_test00000004" },
  ]);
  expect(report.modulePath).toBe("deploy/opentofu");
});

test("readCapsuleSourceFiles keeps module paths relative to the snapshot archive", async () => {
  const observedOptions: unknown[] = [];
  const { service } = makeService({
    readCapsuleSourceFiles: async (_snapshot, options) => {
      observedOptions.push(options);
      return [];
    },
  });
  const snapshot = (id: string): SourceSnapshot => ({
    id,
    origin: "git",
    workspaceId: "workspace_1",
    sourceId: "source_1",
    url: "https://github.com/example/app.git",
    ref: "main",
    resolvedCommit: "a".repeat(40),
    path: "infra",
    archiveRef: `archive-${id}`,
    archiveDigest: `sha256:${"a".repeat(64)}`,
    archiveSizeBytes: 1,
    fetchedByRunId: "sync_1",
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });

  await service.readCapsuleSourceFiles(snapshot("snapshot_equal"), {
    modulePath: "infra",
  });
  await service.readCapsuleSourceFiles(snapshot("snapshot_nested"), {
    modulePath: "infra/prod",
  });
  await service.readCapsuleSourceFiles(snapshot("snapshot_prefix"), {
    modulePath: "infrastructure",
  });
  await service.readCapsuleSourceFiles(snapshot("snapshot_root"), {
    modulePath: ".",
  });

  expect(observedOptions).toEqual([
    { modulePath: "infra" },
    { modulePath: "infra/prod" },
    { modulePath: "infrastructure" },
    undefined,
  ]);
});
