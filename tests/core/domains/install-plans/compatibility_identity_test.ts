import { expect, test } from "bun:test";

import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { defaultCapsuleInstallConfig } from "../../../../core/domains/capsules/default_install_config.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  SourcesService,
  type InstallPlanCompatibilityCheckRequest,
} from "../../../../core/domains/sources/mod.ts";

test("install-plan compatibility identity canonically recovers one exact analysis", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putInstallConfig(defaultCapsuleInstallConfig());
  let analysisCount = 0;
  let idCount = 0;
  const service = new SourcesService({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: () => new Date("2026-08-21T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_ordinary${(idCount += 1)}`,
    newHookSecret: () => "whk_test_only",
    readCapsuleSourceFiles: async () => {
      analysisCount += 1;
      return [{ path: "main.tf", text: "terraform {}" }];
    },
  });
  const { source } = await service.createSource({
    workspaceId: "ws_install_identity",
    name: "identity",
    url: "https://github.com/takos/identity.git",
    defaultRef: "main",
  });
  const { run: sync } = await service.createSync(source.id, {
    intent: "manual_plan",
  });
  await store.putSourceSnapshot({
    id: sync.snapshotId!,
    origin: "git",
    workspaceId: source.workspaceId,
    sourceId: source.id,
    url: source.url,
    ref: "main",
    resolvedCommit: "a".repeat(40),
    path: ".",
    archiveRef: sync.archiveRef,
    archiveDigest: `sha256:${"b".repeat(64)}`,
    archiveSizeBytes: 42,
    repositoryManifest: { status: "absent" },
    fetchedByRunId: sync.id,
    fetchedAt: "2026-08-21T00:00:00.000Z",
  });

  const request: InstallPlanCompatibilityCheckRequest = {
    sourceSnapshotId: sync.snapshotId,
    modulePath: ".",
    installConfigId: "cfg-default-opentofu-capsule",
    installPlanIdentity: {
      runId: "ccr_0123456789abcdef",
      reportId: "caprep_0123456789abcdef",
      createdBy:
        "git-install-plan:gip_abcdef0123456789:0123456789abcdef",
    },
  };
  const first = await service.createCompatibilityCheck(source.id, request);
  const replay = await service.createCompatibilityCheck(source.id, request);

  expect(replay).toEqual(first);
  expect(analysisCount).toBe(1);
  expect(first).toMatchObject({
    report: {
      id: request.installPlanIdentity.reportId,
      sourceId: source.id,
      sourceSnapshotId: sync.snapshotId,
      modulePath: ".",
    },
    run: {
      id: request.installPlanIdentity.runId,
      compatibilityReportId: request.installPlanIdentity.reportId,
      createdBy: request.installPlanIdentity.createdBy,
      status: "succeeded",
    },
  });
  expect(
    await store.getCompatibilityCheckRun(request.installPlanIdentity.runId),
  ).toEqual(first.run);
  expect(
    await store.getCapsuleCompatibilityReport(
      request.installPlanIdentity.reportId,
    ),
  ).toEqual(first.report);

  await store.putCapsuleCompatibilityReport({
    ...first.report,
    modulePath: "different/module",
  });
  await expect(
    service.createCompatibilityCheck(source.id, request),
  ).rejects.toThrow(
    "install-plan compatibility identity is already bound to different evidence",
  );
  expect(analysisCount).toBe(1);
});

test("revision-plan compatibility identity pins the existing Capsule and recovers one exact analysis", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putInstallConfig(defaultCapsuleInstallConfig());
  let analysisCount = 0;
  let idCount = 0;
  const service = new SourcesService({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: () => new Date("2026-08-21T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_ordinary${(idCount += 1)}`,
    newHookSecret: () => "whk_test_only",
    readCapsuleSourceFiles: async () => {
      analysisCount += 1;
      return [{ path: "main.tf", text: "terraform {}" }];
    },
  });
  const { source } = await service.createSource({
    workspaceId: "ws_revision_identity",
    name: "revision-identity",
    url: "https://github.com/takos/revision-identity.git",
    defaultRef: "main",
  });
  const { run: sync } = await service.createSync(source.id, {
    intent: "manual_plan",
  });
  await store.putSourceSnapshot({
    id: sync.snapshotId!,
    origin: "git",
    workspaceId: source.workspaceId,
    sourceId: source.id,
    url: source.url,
    ref: "release/v2",
    resolvedCommit: "c".repeat(40),
    path: ".",
    archiveRef: sync.archiveRef,
    archiveDigest: `sha256:${"d".repeat(64)}`,
    archiveSizeBytes: 84,
    repositoryManifest: { status: "absent" },
    fetchedByRunId: sync.id,
    fetchedAt: "2026-08-21T00:00:00.000Z",
  });
  await store.putCapsule({
    id: "cap_revision_identity",
    workspaceId: source.workspaceId,
    projectId: "project_revision_identity",
    name: "revision-identity",
    slug: "revision-identity",
    sourceId: source.id,
    installConfigId: "cfg-default-opentofu-capsule",
    environment: "production",
    currentStateGeneration: 3,
    status: "active",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  });

  const request: InstallPlanCompatibilityCheckRequest = {
    sourceSnapshotId: sync.snapshotId,
    capsuleId: "cap_revision_identity",
    installPlanIdentity: {
      runId: "ccr_fedcba9876543210",
      reportId: "caprep_fedcba9876543210",
      createdBy:
        "git-revision-plan:grp_0123456789abcdef:fedcba9876543210",
    },
  };
  const first = await service.createCompatibilityCheck(source.id, request);
  const replay = await service.createCompatibilityCheck(source.id, request);

  expect(replay).toEqual(first);
  expect(analysisCount).toBe(1);
  expect(first).toMatchObject({
    report: {
      id: request.installPlanIdentity.reportId,
      sourceId: source.id,
      capsuleId: "cap_revision_identity",
      sourceSnapshotId: sync.snapshotId,
    },
    run: {
      id: request.installPlanIdentity.runId,
      capsuleId: "cap_revision_identity",
      compatibilityReportId: request.installPlanIdentity.reportId,
      createdBy: request.installPlanIdentity.createdBy,
      status: "succeeded",
    },
  });
});
