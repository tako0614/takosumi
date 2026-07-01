import { expect, test } from "bun:test";

import {
  SourcesService,
  normalizedModuleObjectKey,
  sourceArchiveObjectKey,
} from "../../../../core/domains/sources/mod.ts";
import {
  InMemoryOpenTofuDeploymentStore,
  type StoredSource,
} from "../../../../core/domains/deploy-control/store.ts";
import type { Connection } from "@takosumi/internal/deploy-control-api";
import { MemoryObjectStorage } from "../../../../core/adapters/object-storage/mod.ts";
import type { SourceSnapshot } from "takosumi-contract/sources";

function makeService(
  overrides: {
    enqueueSourceSync?: (d: {
      action: "source_sync";
      runId: string;
      spaceId: string;
      sourceId: string;
    }) => Promise<void>;
    readCapsuleSourceFiles?: (
      snapshot: SourceSnapshot,
    ) => Promise<readonly { readonly path: string; readonly text: string }[]>;
    normalizedArtifactStorage?: MemoryObjectStorage;
  } = {},
) {
  const store = new InMemoryOpenTofuDeploymentStore();
  let counter = 0;
  const service = new SourcesService({
    store,
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
    ...(overrides.normalizedArtifactStorage
      ? { normalizedArtifactStorage: overrides.normalizedArtifactStorage }
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
    scope: "space",
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
    spaceId: "space_1",
    name: "my repo",
    url: "https://github.com/acme/repo.git",
  });
  expect(source.id).toMatch(/^src_/);
  expect(source.status).toBe("active");
  expect(source.defaultRef).toBe("main");
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
      spaceId: "space_1",
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
    "ssh://git@metadata.google.internal/repo.git",
  ];
  for (const url of blocked) {
    const { service } = makeService();
    await expect(
      service.createSource({
        spaceId: "space_1",
        name: "blocked",
        url,
      }),
    ).rejects.toThrow(/blocked_host/);
  }
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

test("recordArtifactSnapshot stores a no-Source prepared artifact snapshot", async () => {
  const { store, service } = makeService();
  const snapshot = await service.recordArtifactSnapshot({
    spaceId: "space_1",
    url: "https://artifacts.example.com/capsule/source.tar.zst",
    snapshotId: "snap_artifact0001",
    archiveObjectKey:
      "spaces/space_1/artifact-snapshots/snap_artifact0001/source.tar.zst",
    archiveDigest:
      "sha256:ABCDEFabcdef0000000000000000000000000000000000000000000000000000",
    archiveSizeBytes: 1234,
    path: "infra",
  });

  expect(snapshot).toMatchObject({
    id: "snap_artifact0001",
    origin: "artifact",
    spaceId: "space_1",
    url: "https://artifacts.example.com/capsule/source.tar.zst",
    ref: "artifact",
    resolvedCommit:
      "abcdefabcdef0000000000000000000000000000000000000000000000000000",
    path: "infra",
    archiveSizeBytes: 1234,
    fetchedByRunId: "artifact",
  });
  expect(snapshot.sourceId).toBeUndefined();
  expect(await store.getSourceSnapshot(snapshot.id)).toEqual(snapshot);
});

test("listSources / getSource project public records only", async () => {
  const { service } = makeService();
  await service.createSource({
    spaceId: "space_1",
    name: "a",
    url: "https://github.com/a/b",
    autoSync: true,
  });
  const list = await service.listSources("space_1");
  expect(list.sources).toHaveLength(1);
  expect(JSON.stringify(list.sources)).not.toContain("hookSecretHash");
  expect(list.sources[0]?.autoSync).toBe(true);
  const got = await service.getSource(list.sources[0].id);
  expect(got.source.id).toBe(list.sources[0].id);
  expect(got.source.autoSync).toBe(true);
});

test("patchSource updates fields, autoSync, and clears authConnectionId with null", async () => {
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
    autoSync: true,
    authConnectionId: null,
  });
  expect(patched.source.name).toBe("renamed");
  expect(patched.source.defaultRef).toBe("release");
  expect(patched.source.status).toBe("disabled");
  expect(patched.source.autoSync).toBe(true);
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

test("createSync dedupe returns and re-enqueues the existing queued run", async () => {
  const dispatched: unknown[] = [];
  const { service } = makeService({
    enqueueSourceSync: async (d) => {
      dispatched.push(d);
    },
  });
  const { source } = await service.createSource({
    spaceId: "space_1",
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
      spaceId: "space_1",
      sourceId: source.id,
    },
    {
      action: "source_sync",
      runId: first.run.id,
      spaceId: "space_1",
      sourceId: source.id,
    },
  ]);
});

test("createSync dedupe does not re-enqueue a fresh running run", async () => {
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

test("createSync dedupe re-enqueues a stale running run", async () => {
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

  expect(second.run.id).toBe(first.run.id);
  expect(second.run.status).toBe("running");
  expect(dispatched).toEqual([
    {
      action: "source_sync",
      runId: first.run.id,
      spaceId: "space_1",
      sourceId: source.id,
    },
  ]);
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
  const seed = async (
    id: string,
    status: StoredSource["status"],
    autoSync: boolean,
  ) => {
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

test("createCompatibilityCheck stores normalized auto-capsulized artifact", async () => {
  const objectStorage = new MemoryObjectStorage({
    clock: () => new Date("2026-06-06T00:00:01.000Z"),
  });
  const { store, service } = makeService({
    normalizedArtifactStorage: objectStorage,
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
    spaceId: "space_1",
    name: "capsule",
    url: "https://github.com/acme/capsule.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveObjectKey: run.archiveObjectKey,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });

  const { report, run: compatibilityResponseRun } =
    await service.createCompatibilityCheck(source.id, {
      sourceSnapshotId: run.snapshotId,
    });

  expect(report.level).toBe("auto_capsulized");
  expect(report.normalizedObjectKey).toBe(
    normalizedModuleObjectKey({
      ...run,
      id: run.snapshotId!,
      sourceId: source.id,
      resolvedCommit: "abc123",
      archiveDigest: "sha256:source",
      archiveSizeBytes: 100,
      fetchedByRunId: run.id,
      fetchedAt: "2026-06-06T00:00:00.000Z",
    } as SourceSnapshot),
  );
  expect(report.normalizedDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  const stored = await objectStorage.getObject({
    bucket: "takos-artifacts",
    key: report.normalizedObjectKey!,
    expectedDigest: report.normalizedDigest as `sha256:${string}`,
  });
  expect(stored).toBeDefined();
  const body = new TextDecoder().decode(stored!.body);
  expect(body).toContain('"kind": "takosumi.normalized-capsule@v1"');
  expect(body).not.toContain('backend "s3"');
  expect(body).not.toContain('provider "cloudflare"');
  const compatibilityRun =
    await store.getCompatibilityCheckRun("ccr_test00000004");
  expect(compatibilityRun).toMatchObject({
    id: "ccr_test00000004",
    spaceId: "space_1",
    sourceId: source.id,
    type: "compatibility_check",
    status: "succeeded",
    sourceSnapshotId: run.snapshotId,
    compatibilityReportId: report.id,
    createdBy: "system",
  });
  expect(compatibilityResponseRun).toEqual(compatibilityRun);
});

test("createCompatibilityCheck applies Installation policy to Gate severity", async () => {
  const { store, service } = makeService({
    readCapsuleSourceFiles: async () => [
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
    ],
  });
  await store.putSpace({
    id: "space_1",
    handle: "space",
    displayName: "Space",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const { source } = await service.createSource({
    spaceId: "space_1",
    name: "policy-capsule",
    url: "https://github.com/acme/policy-capsule.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveObjectKey: run.archiveObjectKey,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putInstallConfig({
    id: "cfg_policy",
    name: "policy",
    trustLevel: "space",
    normalization: {
      allowBackendRewrite: true,
      allowProviderLift: true,
      allowAliasInjection: true,
    },
    variableMapping: {},
    outputAllowlist: {},
    policy: {
      allowedProviders: ["registry.opentofu.org/custom/provider"],
      allowedResourceTypes: ["custom_resource", "null_resource"],
      allowedDataSourceTypes: ["external"],
      allowedProvisionerTypes: ["local-exec"],
    },
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putInstallation({
    id: "inst_policy",
    spaceId: "space_1",
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
    installationId: "inst_policy",
  });

  expect(report.level).toBe("ready");
  expect(report.findings).toEqual([]);
  expect(report.providers[0]).toMatchObject({ allowed: true });
  expect(report.resources.every((resource) => resource.allowed)).toBe(true);
  expect(report.dataSources).toEqual([{ type: "external", allowed: true }]);
  expect(report.provisioners).toEqual([{ type: "local-exec", allowed: true }]);
});

test("createCompatibilityCheck lifts unsupported -> ready via a curated bounded installConfigId (no Installation)", async () => {
  // The catalog "選んで入れる" deep-link path: a vetted first-party module whose
  // resource type is OUTSIDE the instance-wide DEFAULT allowlist becomes
  // installable when its curated bounded InstallConfig is supplied, WITHOUT an
  // Installation and WITHOUT widening the default allowlist.
  // cloudflare_dns_record stays OUTSIDE the Gateway-backed coverage allowlist (it can
  // repoint arbitrary hostnames), so it is the right type to demonstrate that a
  // curated bounded InstallConfig lifts a type the default rejects.
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
  await store.putSpace({
    id: "space_1",
    handle: "space",
    displayName: "Space",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const { source } = await service.createSource({
    spaceId: "space_1",
    name: "dns-capsule",
    url: "https://github.com/acme/dns-capsule.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveObjectKey: run.archiveObjectKey,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });
  // A built-in `official` InstallConfig has no spaceId and is usable from any
  // Space; its policy is the BOUNDED minimal allowlist for this module only.
  await store.putInstallConfig({
    id: "cfg-official-dns-capsule",
    name: "dns-capsule",
    trustLevel: "official",
    variableMapping: {},
    outputAllowlist: {},
    policy: {
      allowedProviders: ["cloudflare/cloudflare"],
      allowedResourceTypes: ["cloudflare_dns_record"],
    },
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });

  // Without the curated config, the DEFAULT allowlist rejects the resource.
  const baseline = await service.createCompatibilityCheck(source.id, {
    sourceSnapshotId: run.snapshotId,
  });
  expect(baseline.report.level).toBe("unsupported");
  expect(
    baseline.report.findings.some(
      (f) => f.code === "resource_type_not_allowed",
    ),
  ).toBe(true);

  // With the curated bounded config, the Gate passes (ready) and the resource
  // is allowed — yet the global default allowlist is untouched (the baseline
  // above still rejects it).
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

test("createCompatibilityCheck rejects a curated installConfig from another space", async () => {
  const { store, service } = makeService({
    readCapsuleSourceFiles: async () => [
      { path: "main.tf", text: 'output "x" { value = "y" }' },
    ],
  });
  await store.putSpace({
    id: "space_1",
    handle: "space",
    displayName: "Space",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const { source } = await service.createSource({
    spaceId: "space_1",
    name: "capsule",
    url: "https://github.com/acme/capsule.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveObjectKey: run.archiveObjectKey,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });
  // A Space-scoped config (has a spaceId) owned by a DIFFERENT space must not be
  // borrowable to gate another space's check.
  await store.putInstallConfig({
    id: "cfg_other_space",
    spaceId: "space_2",
    name: "other",
    trustLevel: "space",
    variableMapping: {},
    outputAllowlist: {},
    policy: { allowedResourceTypes: ["cloudflare_pages_project"] },
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  await expect(
    service.createCompatibilityCheck(source.id, {
      sourceSnapshotId: run.snapshotId,
      installConfigId: "cfg_other_space",
    }),
  ).rejects.toThrow(/not available in space/);
});

test("createCompatibilityCheck rejects an installation from another space", async () => {
  const { store, service } = makeService();
  const { source } = await service.createSource({
    spaceId: "space_1",
    name: "capsule",
    url: "https://github.com/acme/capsule.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveObjectKey: run.archiveObjectKey,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putInstallation({
    id: "inst_foreign",
    spaceId: "space_2",
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
      installationId: "inst_foreign",
    }),
  ).rejects.toThrow(/not in source space/);
});

test("createCompatibilityCheck rejects an installation for another source", async () => {
  const { store, service } = makeService();
  const { source } = await service.createSource({
    spaceId: "space_1",
    name: "capsule",
    url: "https://github.com/acme/capsule.git",
  });
  const { source: otherSource } = await service.createSource({
    spaceId: "space_1",
    name: "other",
    url: "https://github.com/acme/other.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveObjectKey: run.archiveObjectKey,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putInstallation({
    id: "inst_other_source",
    spaceId: "space_1",
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
      installationId: "inst_other_source",
    }),
  ).rejects.toThrow(/does not use source/);
});

// After the credential-model collapse the standalone Provider Catalog (and its
// per-provider `ownershipOptions` enrichment) is removed: provider setup is
// computed from the provider registry, and a Capsule's required providers are
// discovered straight from its source HCL. This test now verifies that
// discovery + the guided-vs-generic provider distinction the catalog used to
// drive.
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
    spaceId: "space_1",
    name: "providers",
    url: "https://github.com/acme/providers.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveObjectKey: run.archiveObjectKey,
    archiveDigest: "sha256:source",
    archiveSizeBytes: 100,
    fetchedByRunId: run.id,
    fetchedAt: "2026-06-06T00:00:00.000Z",
  });

  const { report } = await service.createCompatibilityCheck(source.id, {
    sourceSnapshotId: run.snapshotId,
  });

  const providerBySource = new Map(
    report.providers.map((provider) => [provider.source, provider]),
  );
  expect(providerBySource.get("hashicorp/aws")?.allowed).toBe(true);
  expect(providerBySource.get("vercel/vercel")?.allowed).toBe(true);
  expect(providerBySource.get("draft/provider")?.allowed).toBe(true);

  // Guided providers (aws) need no explicit-connection nudge; unknown providers
  // (vercel/draft) are flagged to wire an explicit Provider Connection.
  const genericConnectionMessages = report.findings
    .filter((finding) => finding.code === "generic_provider_connection_required")
    .map((finding) => finding.message);
  expect(
    genericConnectionMessages.some((message) =>
      message.includes("vercel/vercel"),
    ),
  ).toBe(true);
  expect(
    genericConnectionMessages.some((message) =>
      message.includes("draft/provider"),
    ),
  ).toBe(true);
  expect(
    genericConnectionMessages.some((message) =>
      message.includes("hashicorp/aws"),
    ),
  ).toBe(false);
});

test("createCompatibilityCheck returns an unsupported report when analysis fails", async () => {
  const { store, service } = makeService({
    readCapsuleSourceFiles: async () => {
      throw new Error("runner unavailable");
    },
  });
  const { source } = await service.createSource({
    spaceId: "space_1",
    name: "capsule",
    url: "https://github.com/acme/capsule.git",
  });
  const { run } = await service.createSync(source.id);
  await store.putSourceSnapshot({
    id: run.snapshotId!,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "abc123",
    path: ".",
    archiveObjectKey: run.archiveObjectKey,
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
    providers: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    normalizedObjectKey: run.archiveObjectKey,
    normalizedDigest: "sha256:source",
  });
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
    spaceId: "space_1",
    sourceId: source.id,
    type: "compatibility_check",
    status: "succeeded",
    sourceSnapshotId: run.snapshotId,
    compatibilityReportId: "caprep_test00000005",
    createdBy: "system",
  });
  expect(compatibilityRun?.errorCode).toBe("runner unavailable");
});
