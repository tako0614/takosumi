import { expect, test } from "bun:test";

import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { defaultCapsuleInstallConfig } from "../../../../core/domains/capsules/default_install_config.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  SourcesService,
  type InstallPlanCompatibilityCheckRequest,
} from "../../../../core/domains/sources/mod.ts";
import type { CapsuleCompatibilityAnalyzer } from "../../../../core/domains/sources/capsule_compatibility.ts";
import type { Run } from "takosumi-contract/runs";

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

class PausingCompatibilityEvidenceReadStore extends InMemoryOpenTofuControlStore {
  readonly evidenceReadStarted = deferred<void>();
  readonly releaseEvidenceRead = deferred<void>();
  #pauseNextEvidenceRead = false;

  pauseNextEvidenceRead(): void {
    this.#pauseNextEvidenceRead = true;
  }

  override async getCompatibilityCheckRun(id: string) {
    if (this.#pauseNextEvidenceRead) {
      this.#pauseNextEvidenceRead = false;
      this.evidenceReadStarted.resolve();
      await this.releaseEvidenceRead.promise;
    }
    return await super.getCompatibilityCheckRun(id);
  }
}

function readyCompatibilityAnalyzer(
  onAnalyze: () => void,
): CapsuleCompatibilityAnalyzer {
  return {
    async analyze() {
      onAnalyze();
      return {
        level: "ready",
        findings: [],
        providerPackages: [],
        rootProviderRequirements: [],
        resources: [],
        dataSources: [],
        provisioners: [],
        rootModuleVariables: [],
        rootModuleVariableDeclarations: [],
        rootModuleOutputs: [],
      };
    },
  };
}

async function seedCompatibilityIdentityFixture(
  store: InMemoryOpenTofuControlStore,
  analyzer: CapsuleCompatibilityAnalyzer,
) {
  await store.putWorkspace({
    id: "ws_install_identity_race",
    handle: "install-identity-race",
    displayName: "Install identity race",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
  await store.putInstallConfig(defaultCapsuleInstallConfig());
  let idCount = 0;
  const service = new SourcesService({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    now: () => new Date("2026-08-21T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_race${(idCount += 1)}`,
    newHookSecret: () => "whk_test_only",
    compatibilityAnalyzer: analyzer,
    readCapsuleSourceFiles: async () => [
      { path: "main.tf", text: "terraform {}" },
    ],
  });
  const { source } = await service.createSource({
    workspaceId: "ws_install_identity_race",
    name: "identity-race",
    url: "https://github.com/takos/identity-race.git",
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
      createdBy: "git-install-plan:gip_0123456789abcdef:0123456789abcdef",
    },
  };
  return { service, source, sync, request };
}

test("terminal install-plan compatibility replay with captured null survives a paused drain", async () => {
  const store = new PausingCompatibilityEvidenceReadStore();
  let analysisCount = 0;
  const { service, source, request } = await seedCompatibilityIdentityFixture(
    store,
    readyCompatibilityAnalyzer(() => {
      analysisCount += 1;
    }),
  );
  const first = await service.createCompatibilityCheck(source.id, request, {
    kind: "fresh",
  });
  const beforeRun = await store.getCompatibilityCheckRun(
    request.installPlanIdentity.runId,
  );
  const beforeReport = await store.getCapsuleCompatibilityReport(
    request.installPlanIdentity.reportId,
  );
  expect(beforeRun).toEqual(first.run);
  expect(beforeReport).toEqual(first.report);

  store.pauseNextEvidenceRead();
  const replaying = service.createCompatibilityCheck(source.id, request, {
    kind: "captured",
    authority: null,
  });
  await store.evidenceReadStarted.promise;
  const management = await store.getWorkspaceManagement(source.workspaceId);
  await store.beginWorkspaceDraining(source.workspaceId, {
    workspaceId: source.workspaceId,
    managementState: "active",
    managementEpoch: management!.managementEpoch,
  });
  store.releaseEvidenceRead.resolve();

  const replay = await replaying;
  expect(replay).toEqual(first);
  expect(analysisCount).toBe(1);
  expect(await store.getCompatibilityCheckRun(request.installPlanIdentity.runId)).toEqual(
    beforeRun,
  );
  expect(await store.getCapsuleCompatibilityReport(request.installPlanIdentity.reportId)).toEqual(
    beforeReport,
  );
});

test("running install-plan compatibility resumes exact evidence during a drain with its original authority", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let analysisCount = 0;
  const { service, source, sync, request } =
    await seedCompatibilityIdentityFixture(
      store,
      readyCompatibilityAnalyzer(() => {
        analysisCount += 1;
      }),
    );
  const originalAuthority = {
    workspaceId: source.workspaceId,
    managementState: "active" as const,
    managementEpoch: 1,
  };
  const running: Run = {
    id: request.installPlanIdentity.runId,
    workspaceId: source.workspaceId,
    sourceId: source.id,
    type: "compatibility_check",
    status: "running",
    sourceSnapshotId: sync.snapshotId,
    createdBy: request.installPlanIdentity.createdBy,
    createdAt: "2026-08-21T00:00:00.000Z",
    startedAt: "2026-08-21T00:00:00.000Z",
  };
  expect(
    await store.beginCompatibilityCheckRun(running, originalAuthority),
  ).toMatchObject({ status: "created", run: running });
  const draining = await store.beginWorkspaceDraining(
    source.workspaceId,
    originalAuthority,
  );
  expect(draining.status).toBe("started");

  const resumed = await service.createCompatibilityCheck(source.id, request, {
    kind: "captured",
    authority: originalAuthority,
  });

  expect(resumed.run.status).toBe("succeeded");
  expect(resumed.run.id).toBe(running.id);
  expect(resumed.report.id).toBe(request.installPlanIdentity.reportId);
  expect(analysisCount).toBe(1);
  expect(await store.getCompatibilityCheckRun(running.id)).toEqual(resumed.run);
});

test("authorityless running install-plan compatibility evidence is never resumed", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let analysisCount = 0;
  const { service, source, sync, request } =
    await seedCompatibilityIdentityFixture(
      store,
      readyCompatibilityAnalyzer(() => {
        analysisCount += 1;
      }),
    );
  const running: Run = {
    id: request.installPlanIdentity.runId,
    workspaceId: source.workspaceId,
    sourceId: source.id,
    type: "compatibility_check",
    status: "running",
    sourceSnapshotId: sync.snapshotId,
    createdBy: request.installPlanIdentity.createdBy,
    createdAt: "2026-08-21T00:00:00.000Z",
    startedAt: "2026-08-21T00:00:00.000Z",
  };
  // Public compatibility writes cannot manufacture the private authority;
  // this models a legacy running row that is observable but not resumable.
  await store.putCompatibilityCheckRun(running);

  await expect(
    service.createCompatibilityCheck(source.id, request, {
      kind: "captured",
      authority: null,
    }),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "workspace_management_admission_conflict" },
  });
  expect(analysisCount).toBe(0);
  expect(await store.getCompatibilityCheckRun(running.id)).toEqual(running);
  expect(
    await store.getCapsuleCompatibilityReport(request.installPlanIdentity.reportId),
  ).toBeUndefined();
});

test("install-plan compatibility identity canonically recovers one exact analysis", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putWorkspace({
    id: "ws_install_identity",
    handle: "install-identity",
    displayName: "Install identity",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
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
  const first = await service.createCompatibilityCheck(source.id, request, {
    kind: "fresh",
  });
  const replay = await service.createCompatibilityCheck(source.id, request, {
    kind: "fresh",
  });

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
    service.createCompatibilityCheck(source.id, request, { kind: "fresh" }),
  ).rejects.toThrow(
    "install-plan compatibility identity is already bound to different evidence",
  );
  expect(analysisCount).toBe(1);
});

test("revision-plan compatibility identity pins the existing Capsule and recovers one exact analysis", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putWorkspace({
    id: "ws_revision_identity",
    handle: "revision-identity",
    displayName: "Revision identity",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
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
  const first = await service.createCompatibilityCheck(source.id, request, {
    kind: "fresh",
  });
  const replay = await service.createCompatibilityCheck(source.id, request, {
    kind: "fresh",
  });

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
