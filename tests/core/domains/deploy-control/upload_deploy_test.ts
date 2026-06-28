/**
 * Internal upload deploy compatibility tests.
 *
 * Public local upload deploy is retired. The internal/operator seam may still
 * plan upload/artifact SourceSnapshots, but only against existing legacy
 * source-less Capsules.
 */

import { expect, test } from "bun:test";
import type {
  OpenTofuApplyJob,
  OpenTofuDestroyJob,
  EnqueueRun,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import type { RunnerProfile } from "@takosumi/internal/deploy-control-api";
import {
  applyExpectedGuardFromPlanRun,
  createDefaultRunnerProfiles,
  OpenTofuDeploymentController,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  artifactArchiveObjectKey,
  SourcesService,
  uploadArchiveObjectKey,
} from "../../../../core/domains/sources/mod.ts";
import { CapsulesService } from "../../../../core/domains/capsules/mod.ts";
import {
  CredentialBundle,
  PhaseMintBundle,
} from "../../../../core/adapters/vault/mod.ts";
import { seedInstallationModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { deployUpload } from "../../../../core/domains/deploy-control/upload_deploy.ts";
import type { InstallationProviderEnvBindings } from "takosumi-contract/connections";
import type { InstallConfig } from "takosumi-contract/installations";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const STATE_DIGEST =
  "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const UPLOAD_DIGEST =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CLOUDFLARE_PROVIDER = "registry.opentofu.org/cloudflare/cloudflare";
const NULL_PROVIDER = "registry.opentofu.org/hashicorp/null";
const UPLOAD_PROVIDER_CONNECTIONS: InstallationProviderEnvBindings = [
  {
    provider: "cloudflare",
    alias: "main",
    connectionId: "conn_upload_cf",
  },
];
const CLOUDFLARE_MIRROR_EVIDENCE = {
  provider: CLOUDFLARE_PROVIDER,
  mirrored: true,
  attested: true,
  installationMethod: "filesystem_mirror",
  attestationMethod: "forced_filesystem_mirror_init",
  mirrorPath:
    "/opt/opentofu/provider-mirror/registry.opentofu.org/cloudflare/cloudflare",
} as const;

// A "ready"-level Capsule (proven by the installation-plan compatibility tests):
// required_providers + a resource + an output, no backend/provider block.
const READY_CAPSULE = `
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

resource "aws_s3_bucket" "attachments" {
  bucket = "attachments"
}

output "attachments_bucket" {
  value = aws_s3_bucket.attachments.bucket
}
`;

const NULL_CAPSULE = `
terraform {
  required_providers {
    null = {
      source = "hashicorp/null"
    }
  }
}

resource "null_resource" "example" {}

output "worker_name" {
  value = "null-example"
}
`;

function deterministicIds(): (prefix: string) => string {
  let next = 1;
  return (prefix) => `${prefix}_${String(next++).padStart(4, "0")}`;
}

function sequenceNow(start: number): () => number {
  let value = start;
  return () => value++;
}

interface RecordingRunner extends OpenTofuRunner {
  readonly planJobs: OpenTofuPlanJob[];
  readonly applyJobs: OpenTofuApplyJob[];
  readonly destroyJobs: OpenTofuDestroyJob[];
}

function recordingRunner(
  planResult: Partial<OpenTofuPlanResult> = {},
): RecordingRunner {
  const planJobs: OpenTofuPlanJob[] = [];
  const applyJobs: OpenTofuApplyJob[] = [];
  const destroyJobs: OpenTofuDestroyJob[] = [];
  return {
    planJobs,
    applyJobs,
    destroyJobs,
    plan: (job) => {
      planJobs.push(job);
      return Promise.resolve({
        planDigest: PLAN_DIGEST,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan/tfplan",
          digest: PLAN_DIGEST,
          contentType: "application/vnd.opentofu.plan",
        },
        providerLockDigest: LOCK_DIGEST,
        requiredProviders: [CLOUDFLARE_PROVIDER],
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        planResourceChanges: [],
        ...planResult,
      });
    },
    apply: (job) => {
      applyJobs.push(job);
      return Promise.resolve({
        outputs: {} as never,
        stateDigest: STATE_DIGEST,
      });
    },
    destroy: (job) => {
      destroyJobs.push(job);
      return Promise.resolve({});
    },
  };
}

function fakeProviderVault() {
  const evidence = {
    provider: CLOUDFLARE_PROVIDER,
    connectionId: "fixture",
    delivery: "provider_env" as const,
    rootOnly: false,
    temporary: true,
    ttlEnforced: true,
    phase: "plan" as const,
  };
  return {
    register: () => Promise.reject(new Error("not used")),
    test: () => Promise.resolve({ status: "verified" }),
    revoke: () => Promise.resolve(true),
    mint: () =>
      Promise.resolve(
        new CredentialBundle(
          { CLOUDFLARE_API_TOKEN: "fixture-provider-token" },
          [],
          [evidence],
        ),
      ),
    mintForPhase: () =>
      Promise.resolve(
        new PhaseMintBundle(
          { env: { CLOUDFLARE_API_TOKEN: "fixture-provider-token" } },
          [],
          [evidence],
        ),
      ),
    mintForInstallationProviderEnvBindings: () =>
      Promise.resolve(
        new PhaseMintBundle(
          {
            env: {
              TF_VAR_cloudflare_main_api_token: "fixture-provider-token",
            },
          },
          [],
          [
            {
              ...evidence,
              delivery: "generated_root_variable",
              rootOnly: true,
            },
          ],
        ),
      ),
  };
}

async function setup(
  options: {
    readonly enqueueRun?: EnqueueRun;
    readonly runnerProfiles?: readonly RunnerProfile[];
    readonly defaultRunnerProfileId?: string;
    readonly capsuleSourceText?: string;
    readonly planResult?: Partial<OpenTofuPlanResult>;
  } = {},
) {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(options.planResult);
  // seedInstallationModel creates the Space (space_test) we deploy into; its git
  // Installation is unrelated to the upload Installation under test.
  await seedInstallationModel(store, { environment: "preview" });
  const sources = new SourcesService({
    store,
    now: () => new Date("2026-06-09T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_upload`,
    readCapsuleSourceFiles: () =>
      Promise.resolve([
        { path: "main.tf", text: options.capsuleSourceText ?? READY_CAPSULE },
      ]),
  });
  const installations = new CapsulesService({ store });
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    sourcesService: sources,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
    ...(options.enqueueRun ? { enqueueRun: options.enqueueRun } : {}),
    ...(options.runnerProfiles
      ? { runnerProfiles: options.runnerProfiles }
      : {}),
    ...(options.defaultRunnerProfileId
      ? { defaultRunnerProfileId: options.defaultRunnerProfileId }
      : {}),
  });
  await store.putConnection({
    id: "conn_upload_cf",
    spaceId: "space_test",
    scope: "space",
    provider: "cloudflare",
    providerSource: CLOUDFLARE_PROVIDER,
    kind: "cloudflare_api_token",
    materialization: "secret",
    displayName: "Cloudflare upload env",
    status: "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
    verifiedAt: "2026-06-09T00:00:00.000Z",
  });
  return { store, runner, sources, installations, controller };
}

async function seedLegacyUploadCapsule(
  installations: CapsulesService,
  input: {
    readonly name: string;
    readonly environment?: string;
    readonly runnerId?: string;
    readonly modulePath?: string;
    readonly outputAllowlist?: InstallConfig["outputAllowlist"];
  },
) {
  const environment = input.environment ?? "preview";
  const installConfigId = `cfg_${input.name.replace(/[^a-z0-9]+/g, "_")}`;
  const now = "2026-06-09T00:00:00.000Z";
  await installations.putInstallConfig({
    id: installConfigId,
    spaceId: "space_test",
    workspaceId: "space_test",
    name: `${input.name}-legacy-upload`,
    installType: "opentofu_module",
    trustLevel: "space",
    normalization: {
      allowBackendRewrite: true,
      allowProviderLift: true,
      allowAliasInjection: true,
    },
    ...(input.runnerId ? { runnerId: input.runnerId } : {}),
    ...(input.modulePath ? { modulePath: input.modulePath } : {}),
    variableMapping: {},
    outputAllowlist: input.outputAllowlist ?? {},
    policy: {},
    createdAt: now,
    updatedAt: now,
  });
  return await installations.createCapsule({
    workspaceId: "space_test",
    name: input.name,
    environment,
    installConfigId,
  });
}

async function applyUploadedDeploy(
  store: InMemoryOpenTofuDeploymentStore,
  controller: OpenTofuDeploymentController,
  deploy: Awaited<ReturnType<typeof deployUpload>>,
) {
  const planRun =
    (await store.getPlanRun((deploy.planRun ?? deploy.run).id)) ??
    (() => {
      throw new Error("upload deploy fixture plan run was not persisted");
    })();
  if (planRun.status === "waiting_approval") {
    await controller.approveRun(planRun.id);
  }
  const applied = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  if (applied.applyRun.status !== "succeeded") {
    throw new Error("upload deploy fixture did not apply");
  }
  return applied.applyRun;
}

test("deployUpload rejects creating a new source-less Capsule from an upload snapshot", async () => {
  const { runner, sources, installations, controller } = await setup();
  const snapshot = await sources.recordUploadSnapshot({
    spaceId: "space_test",
    snapshotId: "snap_up1",
    archiveObjectKey: uploadArchiveObjectKey("space_test", "snap_up1"),
    archiveDigest: UPLOAD_DIGEST,
    archiveSizeBytes: 512,
  });
  expect(snapshot.origin).toBe("upload");
  expect(snapshot.sourceId).toBeUndefined();
  expect(snapshot.resolvedCommit).toBe(UPLOAD_DIGEST.slice("sha256:".length));

  await expect(
    deployUpload(
      { installations, controller },
      {
        spaceId: "space_test",
        name: "uploaded-app",
        environment: "preview",
        snapshotId: snapshot.id,
        modulePath: "deploy/opentofu",
        vars: { region: "ap-northeast-1" },
        outputAllowlist: {
          endpoint: { from: "url", type: "url", required: true },
          worker_name: { from: "worker_name", type: "string" },
        },
        providerEnvBindings: UPLOAD_PROVIDER_CONNECTIONS,
      },
    ),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    message: expect.stringContaining("existing source-less legacy Capsule"),
  });
  expect(runner.applyJobs).toHaveLength(0);
  expect(runner.planJobs).toHaveLength(0);
  expect(
    (await installations.listInstallations("space_test")).some(
      (installation) => installation.name === "uploaded-app",
    ),
  ).toBe(false);
});

test("deployUpload plans an artifact snapshot for an existing legacy Capsule", async () => {
  const { runner, sources, installations, controller } = await setup();
  const snapshot = await sources.recordArtifactSnapshot({
    spaceId: "space_test",
    url: "https://artifacts.example.com/app/source.tar.zst",
    snapshotId: "snap_artifact1",
    archiveObjectKey: artifactArchiveObjectKey("space_test", "snap_artifact1"),
    archiveDigest: UPLOAD_DIGEST,
    archiveSizeBytes: 512,
  });
  await seedLegacyUploadCapsule(installations, { name: "artifact-app" });

  const result = await deployUpload(
    { installations, controller },
    {
      spaceId: "space_test",
      name: "artifact-app",
      environment: "preview",
      snapshotId: snapshot.id,
      vars: { region: "ap-northeast-1" },
      providerEnvBindings: UPLOAD_PROVIDER_CONNECTIONS,
    },
  );

  expect(result.created).toBe(false);
  expect(result.installation.sourceId).toBeUndefined();
  expect(result.run.status).toBe("succeeded");
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]?.sourceArchive).toEqual({
    objectKey: artifactArchiveObjectKey("space_test", "snap_artifact1"),
    digest: UPLOAD_DIGEST,
  });
});

test("deployUpload preflights explicit generic runner uploads before dispatch", async () => {
  const genericProfile: RunnerProfile = {
    id: "generic-opentofu-provider",
    name: "Generic OpenTofu provider",
    substrate: "cloudflare-containers",
    allowedProviders: ["*"],
    stateBackend: { kind: "operator-managed", ref: "r2://state" },
    networkPolicy: { mode: "operator-managed" },
    labels: { "takosumi.com/provider-surface": "generic" },
    createdAt: 1,
  };
  const { store, runner, sources, installations, controller } = await setup({
    runnerProfiles: [genericProfile],
    defaultRunnerProfileId: genericProfile.id,
    capsuleSourceText: NULL_CAPSULE,
    planResult: {
      requiredProviders: [NULL_PROVIDER],
      providerInstallation: [],
      planResourceChanges: [],
    },
  });
  const snapshot = await sources.recordUploadSnapshot({
    spaceId: "space_test",
    snapshotId: "snap_generic_profile_upload",
    archiveObjectKey: uploadArchiveObjectKey(
      "space_test",
      "snap_generic_profile_upload",
    ),
    archiveDigest: UPLOAD_DIGEST,
    archiveSizeBytes: 512,
  });
  await seedLegacyUploadCapsule(installations, {
    name: "generic-profile-uploaded-app",
    runnerId: genericProfile.id,
  });

  const result = await deployUpload(
    { installations, controller },
    {
      spaceId: "space_test",
      name: "generic-profile-uploaded-app",
      environment: "preview",
      snapshotId: snapshot.id,
      runnerProfileId: genericProfile.id,
    },
  );

  const planRun = await store.getPlanRun((result.planRun ?? result.run).id);
  expect(planRun?.runnerProfileId).toBe(genericProfile.id);
  expect(planRun?.requiredProviders).toEqual([NULL_PROVIDER]);
  expect(planRun?.status).toBe("succeeded");
  expect(planRun?.policy.status).toBe("passed");
  const installation = await store.getInstallation(result.installation.id);
  expect(installation?.compatibilityReportId).toBeDefined();
  const installConfig = await store.getInstallConfig(result.installConfigId);
  expect(installConfig?.runnerId).toBe(genericProfile.id);
  expect(runner.planJobs[0]?.runnerProfile.id).toBe(genericProfile.id);
  expect(runner.planJobs[0]?.planRun.requiredProviders).toEqual([
    NULL_PROVIDER,
  ]);
  expect(runner.planJobs[0]?.providerInstallationPolicy).toBeUndefined();

  await applyUploadedDeploy(store, controller, result);
  const destroy = await controller.createInstallationDestroyPlan(
    result.installation.id,
  );

  expect(destroy.planRun.status).toBe("waiting_approval");
  expect(destroy.planRun.runnerProfileId).toBe(genericProfile.id);
  expect(destroy.planRun.requiredProviders).toEqual([NULL_PROVIDER]);
  expect(runner.planJobs[1]?.runnerProfile.id).toBe(genericProfile.id);
  expect(runner.planJobs[1]?.planRun.requiredProviders).toEqual([
    NULL_PROVIDER,
  ]);
});

test("deployUpload returns a queued plan before upload compatibility inspection when a run queue is configured", async () => {
  const enqueued: Parameters<EnqueueRun>[0][] = [];
  const { store, runner, sources, installations, controller } = await setup({
    enqueueRun: async (dispatch) => {
      enqueued.push(dispatch);
    },
  });
  const snapshot = await sources.recordUploadSnapshot({
    spaceId: "space_test",
    snapshotId: "snap_queued_upload",
    archiveObjectKey: uploadArchiveObjectKey(
      "space_test",
      "snap_queued_upload",
    ),
    archiveDigest: UPLOAD_DIGEST,
    archiveSizeBytes: 512,
  });
  await seedLegacyUploadCapsule(installations, {
    name: "queued-uploaded-app",
  });

  const result = await deployUpload(
    { installations, controller },
    {
      spaceId: "space_test",
      name: "queued-uploaded-app",
      environment: "preview",
      snapshotId: snapshot.id,
      providerEnvBindings: UPLOAD_PROVIDER_CONNECTIONS,
    },
  );

  expect(result.created).toBe(false);
  expect(result.run.type).toBe("plan");
  expect(result.run.status).toBe("queued");
  expect(enqueued).toEqual([
    {
      action: "plan",
      runId: result.run.id,
      spaceId: "space_test",
    },
  ]);
  expect(runner.planJobs).toHaveLength(0);
  let installation = await store.getInstallation(result.installation.id);
  expect(installation?.compatibilityReportId).toBeUndefined();

  const completed = await controller.runQueuedPlan(result.run.id);

  expect(completed?.status).toBe("succeeded");
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]?.sourceArchive).toEqual({
    objectKey: uploadArchiveObjectKey("space_test", "snap_queued_upload"),
    digest: UPLOAD_DIGEST,
  });
  installation = await store.getInstallation(result.installation.id);
  expect(installation?.compatibilityReportId).toBeDefined();
  const persistedPlan = await store.getPlanRun(result.run.id);
  expect(persistedPlan?.compatibilityReportId).toBe(
    installation?.compatibilityReportId,
  );
});

test("deployUpload queues providerless upload Capsules without Provider Connections", async () => {
  const enqueued: Parameters<EnqueueRun>[0][] = [];
  const { store, runner, sources, installations, controller } = await setup({
    enqueueRun: async (dispatch) => {
      enqueued.push(dispatch);
    },
    planResult: {
      requiredProviders: [],
      providerInstallation: [],
    },
  });
  const snapshot = await sources.recordUploadSnapshot({
    spaceId: "space_test",
    snapshotId: "snap_providerless_upload",
    archiveObjectKey: uploadArchiveObjectKey(
      "space_test",
      "snap_providerless_upload",
    ),
    archiveDigest: UPLOAD_DIGEST,
    archiveSizeBytes: 512,
  });
  await seedLegacyUploadCapsule(installations, {
    name: "providerless-uploaded-app",
  });

  const result = await deployUpload(
    { installations, controller },
    {
      spaceId: "space_test",
      name: "providerless-uploaded-app",
      environment: "preview",
      snapshotId: snapshot.id,
      vars: {
        name: "providerless-uploaded-app",
        base_url: "https://example.invalid/providerless-uploaded-app",
      },
      outputAllowlist: {
        url: { from: "url", type: "url", required: true },
        worker_name: { from: "worker_name", type: "string", required: true },
      },
    },
  );

  const planRun = await store.getPlanRun(result.run.id);
  expect(result.created).toBe(false);
  expect(result.run.type).toBe("plan");
  expect(result.run.status).toBe("queued");
  expect(enqueued).toEqual([
    {
      action: "plan",
      runId: result.run.id,
      spaceId: "space_test",
    },
  ]);
  expect(runner.planJobs).toHaveLength(0);
  expect(planRun?.requiredProviders).toEqual([]);
  expect(planRun?.runnerProfileId).toBe("cloudflare-default");
  const installation = await store.getInstallation(result.installation.id);
  expect(installation?.compatibilityReportId).toBeUndefined();
  expect(planRun?.compatibilityReportId).toBeUndefined();
});

test("deployUpload can use an enabled generic profile for providerless upload Capsules", async () => {
  const enqueued: Parameters<EnqueueRun>[0][] = [];
  const genericProfile = createDefaultRunnerProfiles()
    .map((profile) =>
      profile.id === "generic-opentofu-provider"
        ? {
            ...profile,
            labels: {
              ...(profile.labels ?? {}),
              "takosumi.com/profile-enabled": "true",
            },
          }
        : profile,
    )
    .find((profile) => profile.id === "generic-opentofu-provider");
  if (!genericProfile) throw new Error("generic profile fixture missing");
  const { store, runner, sources, installations, controller } = await setup({
    enqueueRun: async (dispatch) => {
      enqueued.push(dispatch);
    },
    runnerProfiles: [genericProfile],
    defaultRunnerProfileId: "generic-opentofu-provider",
    planResult: {
      requiredProviders: [],
      providerInstallation: [],
    },
  });
  const snapshot = await sources.recordUploadSnapshot({
    spaceId: "space_test",
    snapshotId: "snap_providerless_generic_upload",
    archiveObjectKey: uploadArchiveObjectKey(
      "space_test",
      "snap_providerless_generic_upload",
    ),
    archiveDigest: UPLOAD_DIGEST,
    archiveSizeBytes: 512,
  });
  await seedLegacyUploadCapsule(installations, {
    name: "providerless-generic-uploaded-app",
  });

  const result = await deployUpload(
    { installations, controller },
    {
      spaceId: "space_test",
      name: "providerless-generic-uploaded-app",
      environment: "preview",
      snapshotId: snapshot.id,
      vars: {
        name: "providerless-generic-uploaded-app",
        base_url: "https://example.invalid/providerless-generic-uploaded-app",
      },
      outputAllowlist: {
        url: { from: "url", type: "url", required: true },
        worker_name: { from: "worker_name", type: "string", required: true },
      },
    },
  );

  const planRun = await store.getPlanRun(result.run.id);
  expect(result.run.status).toBe("queued");
  expect(enqueued).toEqual([
    {
      action: "plan",
      runId: result.run.id,
      spaceId: "space_test",
    },
  ]);
  expect(runner.planJobs).toHaveLength(0);
  expect(planRun?.requiredProviders).toEqual([]);
  expect(planRun?.runnerProfileId).toBe("generic-opentofu-provider");
  const installation = await store.getInstallation(result.installation.id);
  expect(installation?.compatibilityReportId).toBeUndefined();
  expect(planRun?.compatibilityReportId).toBeUndefined();
});

test("deployUpload leaves an existing legacy Capsule unchanged when orchestration throws", async () => {
  const { sources, installations, controller } = await setup();
  const snapshot = await sources.recordUploadSnapshot({
    spaceId: "space_test",
    snapshotId: "snap_timeout_upload",
    archiveObjectKey: uploadArchiveObjectKey(
      "space_test",
      "snap_timeout_upload",
    ),
    archiveDigest: UPLOAD_DIGEST,
    archiveSizeBytes: 512,
  });
  const legacy = await seedLegacyUploadCapsule(installations, {
    name: "timeout-app",
  });
  const failingController = {
    getSourceSnapshot: (id: string) => controller.getSourceSnapshot(id),
    createInstallationPlan: async () => {
      throw new Error("runner timeout");
    },
  } as unknown as OpenTofuDeploymentController;

  await expect(
    deployUpload(
      { installations, controller: failingController },
      {
        spaceId: "space_test",
        name: "timeout-app",
        environment: "preview",
        snapshotId: snapshot.id,
        providerEnvBindings: UPLOAD_PROVIDER_CONNECTIONS,
      },
    ),
  ).rejects.toThrow("runner timeout");

  const updated = (await installations.listInstallations("space_test")).find(
    (installation) =>
      installation.name === "timeout-app" &&
      installation.environment === "preview",
  );
  expect(updated?.id).toBe(legacy.id);
  expect(updated?.sourceId).toBeUndefined();
  expect(updated?.status).toBe(legacy.status);
});

test("upload-origin Installation destroy-plan reuses the active Deployment SourceSnapshot", async () => {
  const { store, runner, sources, installations, controller } = await setup();
  const snapshot = await sources.recordUploadSnapshot({
    spaceId: "space_test",
    snapshotId: "snap_destroy_upload",
    archiveObjectKey: uploadArchiveObjectKey(
      "space_test",
      "snap_destroy_upload",
    ),
    archiveDigest: UPLOAD_DIGEST,
    archiveSizeBytes: 512,
  });
  await seedLegacyUploadCapsule(installations, {
    name: "uploaded-destroy-app",
  });
  const deploy = await deployUpload(
    { installations, controller },
    {
      spaceId: "space_test",
      name: "uploaded-destroy-app",
      environment: "preview",
      snapshotId: snapshot.id,
      vars: { region: "ap-northeast-1" },
      providerEnvBindings: UPLOAD_PROVIDER_CONNECTIONS,
    },
  );
  await applyUploadedDeploy(store, controller, deploy);

  const destroy = await controller.createInstallationDestroyPlan(
    deploy.installation.id,
  );

  expect(destroy.planRun.operation).toBe("destroy");
  expect(destroy.planRun.status).toBe("waiting_approval");
  expect(destroy.planRun.sourceSnapshotId).toBe(snapshot.id);
  expect(destroy.planRun.baseStateGeneration).toBe(1);
  expect(runner.planJobs).toHaveLength(2);
  expect(runner.planJobs[1]?.sourceArchive).toEqual({
    objectKey: uploadArchiveObjectKey("space_test", "snap_destroy_upload"),
    digest: UPLOAD_DIGEST,
  });

  await controller.approveRun(destroy.planRun.id);
  const destroyed = await controller.createApplyRun({
    planRunId: destroy.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroy.planRun),
  });
  expect(destroyed.applyRun.status).toBe("succeeded");
  expect(runner.destroyJobs).toHaveLength(1);
});

test("upload-origin restore keeps cleanup destroy-plan possible without a current Deployment", async () => {
  const { store, runner, sources, installations, controller } = await setup();
  const snapshot = await sources.recordUploadSnapshot({
    spaceId: "space_test",
    snapshotId: "snap_restore_destroy_upload",
    archiveObjectKey: uploadArchiveObjectKey(
      "space_test",
      "snap_restore_destroy_upload",
    ),
    archiveDigest: UPLOAD_DIGEST,
    archiveSizeBytes: 512,
  });
  await seedLegacyUploadCapsule(installations, {
    name: "uploaded-restore-destroy-app",
  });
  const deploy = await deployUpload(
    { installations, controller },
    {
      spaceId: "space_test",
      name: "uploaded-restore-destroy-app",
      environment: "preview",
      snapshotId: snapshot.id,
      vars: { region: "ap-northeast-1" },
      providerEnvBindings: UPLOAD_PROVIDER_CONNECTIONS,
    },
  );
  await applyUploadedDeploy(store, controller, deploy);
  const installation = await store.getInstallation(deploy.installation.id);
  expect(installation).toBeDefined();
  await store.putBackupRecord({
    id: "bkp_restore_destroy_upload",
    spaceId: installation!.spaceId,
    installationId: installation!.id,
    environment: installation!.environment,
    objectKey:
      "spaces/space_test/backups/bkp_restore_destroy_upload/control.json.zst.enc",
    digest: PLAN_DIGEST,
    sizeBytes: 1,
    createdAt: "2026-06-09T00:00:01.000Z",
  });
  await store.putInstallation({
    ...installation!,
    status: "destroyed",
    currentDeploymentId: undefined,
    currentOutputSnapshotId: undefined,
    currentStateGeneration: 2,
    updatedAt: "2026-06-09T00:00:02.000Z",
  });

  const restore = await controller.createRestoreRun(
    installation!.spaceId,
    "bkp_restore_destroy_upload",
    {
      installationId: installation!.id,
      environment: installation!.environment,
      stateGeneration: 1,
      expectedBackupDigest: PLAN_DIGEST,
    },
  );
  await controller.approveRun(restore.id, { approvedBy: "ops" });
  await controller.runQueuedRestore(restore.id);

  const restored = await store.getInstallation(installation!.id);
  expect(restored?.status).toBe("stale");
  expect(restored?.currentDeploymentId).toBeUndefined();

  const destroy = await controller.createInstallationDestroyPlan(
    installation!.id,
  );

  expect(destroy.planRun.operation).toBe("destroy");
  expect(destroy.planRun.status).toBe("waiting_approval");
  expect(destroy.planRun.sourceSnapshotId).toBe(snapshot.id);
  expect(destroy.planRun.baseStateGeneration).toBe(3);
  expect(runner.planJobs.at(-1)?.sourceArchive).toEqual({
    objectKey: uploadArchiveObjectKey(
      "space_test",
      "snap_restore_destroy_upload",
    ),
    digest: UPLOAD_DIGEST,
  });
});

test("deployUpload is idempotent on name: a second deploy updates, not creates", async () => {
  const { store, sources, installations, controller } = await setup();
  const first = await sources.recordUploadSnapshot({
    spaceId: "space_test",
    snapshotId: "snap_a",
    archiveObjectKey: uploadArchiveObjectKey("space_test", "snap_a"),
    archiveDigest: UPLOAD_DIGEST,
    archiveSizeBytes: 256,
  });
  await seedLegacyUploadCapsule(installations, { name: "iter" });
  const r1 = await deployUpload(
    { installations, controller },
    {
      spaceId: "space_test",
      name: "iter",
      environment: "preview",
      snapshotId: first.id,
      providerEnvBindings: UPLOAD_PROVIDER_CONNECTIONS,
    },
  );
  expect(r1.created).toBe(false);

  const second = await sources.recordUploadSnapshot({
    spaceId: "space_test",
    snapshotId: "snap_b",
    archiveObjectKey: uploadArchiveObjectKey("space_test", "snap_b"),
    archiveDigest: UPLOAD_DIGEST,
    archiveSizeBytes: 256,
  });
  const r2 = await deployUpload(
    { installations, controller },
    {
      spaceId: "space_test",
      name: "iter",
      environment: "preview",
      snapshotId: second.id,
      modulePath: "deploy/updated",
      vars: { changed: "yes" },
      outputAllowlist: {
        url: { from: "url", type: "url", required: true },
      },
    },
  );
  expect(r2.created).toBe(false);
  expect(r2.installation.id).toBe(r1.installation.id);
  const config = await installations.getInstallConfig(r2.installConfigId);
  expect(config.modulePath).toBe("deploy/updated");
  expect(config.variableMapping).toEqual({ changed: "yes" });
  expect(config.outputAllowlist).toEqual({
    url: { from: "url", type: "url", required: true },
  });
});

test("deployUpload rejects provider env bindings without connectionId before persistence", async () => {
  const { store, sources, installations, controller } = await setup();
  const snapshot = await sources.recordUploadSnapshot({
    spaceId: "space_test",
    snapshotId: "snap_bad_owner",
    archiveObjectKey: uploadArchiveObjectKey("space_test", "snap_bad_owner"),
    archiveDigest: UPLOAD_DIGEST,
    archiveSizeBytes: 256,
  });

  await expect(
    deployUpload(
      { installations, controller },
      {
        spaceId: "space_test",
        name: "bad-owner",
        environment: "preview",
        snapshotId: snapshot.id,
        providerEnvBindings: [
          {
            provider: "cloudflare",
          } as never,
        ],
      },
    ),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    message: expect.stringContaining("providerBindings[0].connectionId"),
  });

  const installationsAfter =
    await installations.listInstallations("space_test");
  expect(
    installationsAfter.some(
      (installation) => installation.name === "bad-owner",
    ),
  ).toBe(false);
  expect(
    await store.getInstallationProviderEnvBindingSetByInstallation(
      "bad-owner",
      "preview",
    ),
  ).toBeUndefined();
});

test("deployUpload rejects a snapshot that is not an upload/artifact snapshot", async () => {
  const { installations, controller } = await setup();
  // snap_fixture from seedInstallationModel is a git-origin snapshot.
  await expect(
    deployUpload(
      { installations, controller },
      {
        spaceId: "space_test",
        name: "bad",
        environment: "preview",
        snapshotId: "snap_fixture",
      },
    ),
  ).rejects.toThrow();
});
