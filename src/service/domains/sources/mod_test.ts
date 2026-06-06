import { expect, test } from "bun:test";

import {
  SourcesService,
  sourceArchiveObjectKey,
} from "./mod.ts";
import {
  InMemoryOpenTofuDeploymentStore,
  type StoredSource,
} from "../deploy-control/store.ts";
import type { Connection } from "takosumi-contract/deploy-control-api";

function makeService(overrides: {
  enqueueSourceSync?: (d: {
    action: "source_sync";
    runId: string;
    spaceId: string;
    sourceId: string;
  }) => Promise<void>;
} = {}) {
  const store = new InMemoryOpenTofuDeploymentStore();
  let counter = 0;
  const service = new SourcesService({
    store,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_test${(counter += 1).toString().padStart(8, "0")}`,
    newHookSecret: () => "whk_fixed_secret_value",
    ...(overrides.enqueueSourceSync
      ? { enqueueSourceSync: overrides.enqueueSourceSync }
      : {}),
  });
  return { store, service };
}

async function seedConnection(
  store: InMemoryOpenTofuDeploymentStore,
  id: string,
  spaceId: string,
): Promise<void> {
  const conn: Connection = {
    id,
    spaceId,
    provider: "source_git_https_token",
    kind: "source_git_https_token",
    owner: "customer",
    authMethod: "static_secret",
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
    spaceId: "space_1",
    name: "my repo",
    url: "https://github.com/acme/repo.git",
  });
  expect(source.id).toMatch(/^src_/);
  expect(source.status).toBe("active");
  expect(source.defaultRef).toBe("main");
  expect(source.defaultPath).toBe(".");
  expect(hookSecret).toBe("whk_fixed_secret_value");
  // The public source must NOT carry the hook secret hash or internal fields.
  expect(JSON.stringify(source)).not.toContain("hookSecretHash");
  expect(JSON.stringify(source)).not.toContain("autoSync");
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
      spaceId: "space_1",
      name: "bad",
      url: "file:///etc/passwd",
    }),
  ).rejects.toThrow(/not allowed/);
});

test("createSource rejects an authConnectionId that is not in the space", async () => {
  const { service } = makeService();
  await expect(
    service.createSource({
      spaceId: "space_1",
      name: "x",
      url: "https://github.com/a/b",
      authConnectionId: "conn_missing",
    }),
  ).rejects.toThrow(/does not exist in space/);
});

test("createSource accepts an authConnectionId present in the space", async () => {
  const { store, service } = makeService();
  await seedConnection(store, "conn_git1", "space_1");
  const { source } = await service.createSource({
    spaceId: "space_1",
    name: "x",
    url: "https://github.com/a/b",
    authConnectionId: "conn_git1",
  });
  expect(source.authConnectionId).toBe("conn_git1");
});

test("listSources / getSource project public records only", async () => {
  const { service } = makeService();
  await service.createSource({
    spaceId: "space_1",
    name: "a",
    url: "https://github.com/a/b",
  });
  const list = await service.listSources("space_1");
  expect(list.sources).toHaveLength(1);
  expect(JSON.stringify(list.sources)).not.toContain("hookSecretHash");
  const got = await service.getSource(list.sources[0].id);
  expect(got.source.id).toBe(list.sources[0].id);
});

test("patchSource updates fields and clears authConnectionId with null", async () => {
  const { store, service } = makeService();
  await seedConnection(store, "conn_git1", "space_1");
  const { source } = await service.createSource({
    spaceId: "space_1",
    name: "a",
    url: "https://github.com/a/b",
    authConnectionId: "conn_git1",
  });
  const patched = await service.patchSource(source.id, {
    name: "renamed",
    defaultRef: "release",
    status: "disabled",
    authConnectionId: null,
  });
  expect(patched.source.name).toBe("renamed");
  expect(patched.source.defaultRef).toBe("release");
  expect(patched.source.status).toBe("disabled");
  expect(patched.source.authConnectionId).toBeUndefined();
});

test("createSync persists a queued run, precomputes the archive key, and enqueues", async () => {
  const dispatched: unknown[] = [];
  const { store, service } = makeService({
    enqueueSourceSync: async (d) => {
      dispatched.push(d);
    },
  });
  const { source } = await service.createSource({
    spaceId: "space_1",
    name: "a",
    url: "https://github.com/a/b",
  });
  const { run } = await service.createSync(source.id);
  expect(run.status).toBe("queued");
  expect(run.kind).toBe("source_sync");
  expect(run.ref).toBe("main");
  expect(run.archiveObjectKey).toBe(
    sourceArchiveObjectKey("space_1", source.id, run.snapshotId!),
  );
  expect(dispatched).toEqual([
    {
      action: "source_sync",
      runId: run.id,
      spaceId: "space_1",
      sourceId: source.id,
    },
  ]);
  const stored = await store.getSourceSyncRun(run.id);
  expect(stored?.id).toBe(run.id);
});

test("createSync dedupe returns the existing queued run", async () => {
  const { service } = makeService();
  const { source } = await service.createSource({
    spaceId: "space_1",
    name: "a",
    url: "https://github.com/a/b",
  });
  const first = await service.createSync(source.id, { dedupe: true });
  const second = await service.createSync(source.id, { dedupe: true });
  expect(second.run.id).toBe(first.run.id);
});

test("verifyHookSecret accepts the right bearer and rejects others", async () => {
  const { service } = makeService();
  const { source, hookSecret } = await service.createSource({
    spaceId: "space_1",
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
  const seed = async (id: string, status: StoredSource["status"], autoSync: boolean) => {
    await store.putSource({
      id,
      spaceId: "space_1",
      name: id,
      url: "https://github.com/a/b",
      defaultRef: "main",
      defaultPath: ".",
      status,
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
      hookSecretHash: "deadbeef",
      autoSync,
    });
  };
  await seed("src_a", "active", true);
  await seed("src_b", "active", false);
  await seed("src_c", "disabled", true);
  const scanned = await service.listAutoSyncSources(50);
  expect(scanned.map((s) => s.id)).toEqual(["src_a"]);
  expect((await service.listAutoSyncSources(0)).length).toBe(0);
});
