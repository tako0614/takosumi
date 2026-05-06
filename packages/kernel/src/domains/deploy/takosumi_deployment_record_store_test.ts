import assert from "node:assert/strict";
import {
  InMemoryTakosumiDeploymentRecordStore,
  recordsFromAppliedResources,
} from "./takosumi_deployment_record_store.ts";

const TENANT = "takosumi-deploy";
const NOW_1 = "2026-05-02T00:00:00.000Z";
const NOW_2 = "2026-05-02T00:00:01.000Z";

Deno.test("upsert inserts a new row when (tenantId, name) is fresh", async () => {
  const store = new InMemoryTakosumiDeploymentRecordStore();
  const record = await store.upsert({
    tenantId: TENANT,
    name: "my-app",
    manifest: { resources: [] },
    appliedResources: [],
    status: "applied",
    now: NOW_1,
  });
  assert.equal(record.tenantId, TENANT);
  assert.equal(record.name, "my-app");
  assert.equal(record.status, "applied");
  assert.equal(record.createdAt, NOW_1);
  assert.equal(record.updatedAt, NOW_1);
  assert.ok(record.id.length > 0);
});

Deno.test("upsert updates the same row when natural key matches", async () => {
  const store = new InMemoryTakosumiDeploymentRecordStore();
  const first = await store.upsert({
    tenantId: TENANT,
    name: "my-app",
    manifest: { resources: [] },
    appliedResources: [],
    status: "applied",
    now: NOW_1,
  });
  const second = await store.upsert({
    tenantId: TENANT,
    name: "my-app",
    manifest: { resources: [{ shape: "object-store@v1" }] },
    appliedResources: [{
      resourceName: "logs",
      shape: "object-store@v1",
      providerId: "filesystem",
      handle: "h_1",
      outputs: { ok: true },
      appliedAt: NOW_2,
    }],
    status: "applied",
    now: NOW_2,
  });
  assert.equal(second.id, first.id, "upsert keeps the surrogate id stable");
  assert.equal(second.createdAt, NOW_1);
  assert.equal(second.updatedAt, NOW_2);
  assert.equal(second.appliedResources.length, 1);
  assert.equal(second.appliedResources[0].handle, "h_1");
});

Deno.test("upsert keys tenant and deployment name as a tuple", async () => {
  const store = new InMemoryTakosumiDeploymentRecordStore();
  const first = await store.upsert({
    tenantId: "tenant a",
    name: "app",
    manifest: { name: "first" },
    appliedResources: [],
    status: "applied",
    now: NOW_1,
  });
  const second = await store.upsert({
    tenantId: "tenant",
    name: "a app",
    manifest: { name: "second" },
    appliedResources: [],
    status: "applied",
    now: NOW_2,
  });

  assert.notEqual(second.id, first.id);
  assert.equal((await store.get("tenant a", "app"))?.manifest.name, "first");
  assert.equal((await store.get("tenant", "a app"))?.manifest.name, "second");
});

Deno.test("get returns undefined for missing rows", async () => {
  const store = new InMemoryTakosumiDeploymentRecordStore();
  const missing = await store.get(TENANT, "nope");
  assert.equal(missing, undefined);
});

Deno.test("list filters by tenantId", async () => {
  const store = new InMemoryTakosumiDeploymentRecordStore();
  await store.upsert({
    tenantId: "tenant-a",
    name: "app-1",
    manifest: {},
    appliedResources: [],
    status: "applied",
    now: NOW_1,
  });
  await store.upsert({
    tenantId: "tenant-b",
    name: "app-1",
    manifest: {},
    appliedResources: [],
    status: "applied",
    now: NOW_1,
  });
  const a = await store.list("tenant-a");
  const b = await store.list("tenant-b");
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].tenantId, "tenant-a");
  assert.equal(b[0].tenantId, "tenant-b");
});

Deno.test("markDestroyed clears appliedResources and flips status", async () => {
  const store = new InMemoryTakosumiDeploymentRecordStore();
  await store.upsert({
    tenantId: TENANT,
    name: "my-app",
    manifest: {},
    appliedResources: [{
      resourceName: "logs",
      shape: "object-store@v1",
      providerId: "filesystem",
      handle: "h_1",
      outputs: {},
      appliedAt: NOW_1,
    }],
    status: "applied",
    now: NOW_1,
  });
  const updated = await store.markDestroyed(TENANT, "my-app", NOW_2);
  assert.ok(updated);
  assert.equal(updated!.status, "destroyed");
  assert.equal(updated!.appliedResources.length, 0);
  assert.equal(updated!.updatedAt, NOW_2);
  // createdAt should not be reset
  assert.equal(updated!.createdAt, NOW_1);
});

Deno.test("markDestroyed returns undefined when no row matches", async () => {
  const store = new InMemoryTakosumiDeploymentRecordStore();
  const result = await store.markDestroyed(TENANT, "ghost", NOW_2);
  assert.equal(result, undefined);
});

Deno.test("remove drops the row and returns true once", async () => {
  const store = new InMemoryTakosumiDeploymentRecordStore();
  await store.upsert({
    tenantId: TENANT,
    name: "my-app",
    manifest: {},
    appliedResources: [],
    status: "applied",
    now: NOW_1,
  });
  assert.equal(await store.remove(TENANT, "my-app"), true);
  assert.equal(await store.remove(TENANT, "my-app"), false);
});

Deno.test("recordsFromAppliedResources copies shape from manifest", () => {
  const records = recordsFromAppliedResources(
    [{
      name: "logs",
      providerId: "@takos/selfhost-filesystem",
      handle: "h_1",
      outputs: { ok: true },
    }],
    [{
      shape: "object-store@v1",
      name: "logs",
      provider: "@takos/selfhost-filesystem",
      spec: {},
    }],
    NOW_1,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].shape, "object-store@v1");
  assert.equal(records[0].providerId, "@takos/selfhost-filesystem");
  assert.equal(records[0].handle, "h_1");
  assert.equal(records[0].appliedAt, NOW_1);
});

// --- listReferencedArtifactHashes (mark+sweep GC read side) ------------------

const HASH_A =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const HASH_B =
  "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const HASH_C =
  "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const HASH_D =
  "sha256:4444444444444444444444444444444444444444444444444444444444444444";

Deno.test(
  "listReferencedArtifactHashes finds artifact.hash in manifest tree",
  async () => {
    const store = new InMemoryTakosumiDeploymentRecordStore();
    await store.upsert({
      tenantId: TENANT,
      name: "worker-app",
      manifest: {
        resources: [{
          shape: "worker@v1",
          name: "api",
          provider: "@takos/cloudflare-workers",
          spec: { artifact: { kind: "js-bundle", hash: HASH_A } },
        }],
      },
      appliedResources: [],
      status: "applied",
      now: NOW_1,
    });
    const hashes = await store.listReferencedArtifactHashes();
    assert.equal(hashes.size, 1);
    assert.ok(hashes.has(HASH_A));
  },
);

Deno.test(
  "listReferencedArtifactHashes unions across many records",
  async () => {
    const store = new InMemoryTakosumiDeploymentRecordStore();
    await store.upsert({
      tenantId: TENANT,
      name: "a",
      manifest: { resources: [{ spec: { artifact: { hash: HASH_A } } }] },
      appliedResources: [],
      status: "applied",
      now: NOW_1,
    });
    await store.upsert({
      tenantId: TENANT,
      name: "b",
      manifest: { resources: [{ spec: { artifact: { hash: HASH_B } } }] },
      appliedResources: [],
      status: "applied",
      now: NOW_1,
    });
    const hashes = await store.listReferencedArtifactHashes();
    assert.equal(hashes.size, 2);
  },
);

Deno.test(
  "listReferencedArtifactHashes preserves hash on destroyed records",
  async () => {
    const store = new InMemoryTakosumiDeploymentRecordStore();
    await store.upsert({
      tenantId: TENANT,
      name: "a",
      manifest: { resources: [{ spec: { artifact: { hash: HASH_C } } }] },
      appliedResources: [],
      status: "applied",
      now: NOW_1,
    });
    await store.markDestroyed(TENANT, "a", NOW_2);
    const hashes = await store.listReferencedArtifactHashes();
    assert.equal(
      hashes.size,
      1,
      "destroyed records still pin their manifest's artifacts " +
        "(audit + race-protection)",
    );
  },
);

Deno.test(
  "listReferencedArtifactHashes ignores non-hash strings",
  async () => {
    const store = new InMemoryTakosumiDeploymentRecordStore();
    await store.upsert({
      tenantId: TENANT,
      name: "a",
      manifest: {
        description: "uploaded with kind=sha256:foo",
        resources: [{ spec: { uri: "ghcr.io/example/api:v1", md5: "abcdef" } }],
      },
      appliedResources: [],
      status: "applied",
      now: NOW_1,
    });
    const hashes = await store.listReferencedArtifactHashes();
    assert.equal(hashes.size, 0);
  },
);

Deno.test(
  "listReferencedArtifactHashes scans applied resource outputs too",
  async () => {
    const store = new InMemoryTakosumiDeploymentRecordStore();
    await store.upsert({
      tenantId: TENANT,
      name: "a",
      manifest: { resources: [] },
      appliedResources: [{
        resourceName: "api",
        shape: "worker@v1",
        providerId: "cloudflare-workers",
        handle: "h_1",
        outputs: { deployedArtifact: HASH_D },
        appliedAt: NOW_1,
      }],
      status: "applied",
      now: NOW_1,
    });
    const hashes = await store.listReferencedArtifactHashes();
    assert.equal(hashes.size, 1);
    assert.ok(hashes.has(HASH_D));
  },
);
