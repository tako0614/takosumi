import { expect, test } from "bun:test";

import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import {
  InMemoryOpenTofuControlStore,
  type StoredSource,
} from "../../../../core/domains/deploy-control/store.ts";
import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";
import type { SourceSnapshot } from "takosumi-contract/sources";

function makeService(
  overrides: {
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
  const store = new InMemoryOpenTofuControlStore();
  let counter = 0;
  const service = new SourcesService({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
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
  ) => {
    await store.putSource({
      id,
      workspaceId: "workspace_1",
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
      allowedProviders: ["registry.opentofu.org/custom/provider"],
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
  expect(report.providers[0]).toMatchObject({ allowed: true });
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
    report.providers.map((provider) => [provider.source, provider]),
  );
  expect(providerBySource.get("hashicorp/aws")?.allowed).toBe(true);
  expect(providerBySource.get("vercel/vercel")?.allowed).toBe(true);
  expect(providerBySource.get("draft/provider")?.allowed).toBe(true);

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
    providers: [],
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

test("createCompatibilityCheck treats snapshot path as restored archive root", async () => {
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

  expect(observedOptions).toEqual([{ runId: "ccr_test00000004" }]);
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
});
