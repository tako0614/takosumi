/**
 * Upload deploy orchestration tests (`takosumi deploy` server side).
 *
 * Proves the one capability the dashboard cannot offer: deploying a local
 * working directory. An upload {@link SourceSnapshot} (no git Source) flows
 * through create-or-resolve Installation + Capsule Gate + plan, and the runner
 * receives the upload archive — all without an `installation.sourceId`.
 */

import { expect, test } from "bun:test";
import type {
  OpenTofuApplyJob,
  OpenTofuDestroyJob,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRunner,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuDeploymentController,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  SourcesService,
  uploadArchiveObjectKey,
} from "../../../../core/domains/sources/mod.ts";
import { InstallationsService } from "../../../../core/domains/installations/mod.ts";
import {
  CredentialBundle,
  PhaseMintBundle,
} from "../../../../core/adapters/vault/mod.ts";
import { seedInstallationModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { deployUpload } from "../../../../core/domains/deploy-control/upload_deploy.ts";
import type { InstallationProviderEnvBindings } from "takosumi-contract/provider-envs";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const STATE_DIGEST =
  "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const UPLOAD_DIGEST =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CLOUDFLARE_PROVIDER = "registry.opentofu.org/cloudflare/cloudflare";
const UPLOAD_PROVIDER_CONNECTIONS: InstallationProviderEnvBindings = [
  {
    provider: "cloudflare",
    alias: "main",
    envId: "penv_upload_cf",
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
        new CredentialBundle(
          { TF_VAR_cloudflare_main_api_token: "fixture-provider-token" },
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

async function setup() {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  // seedInstallationModel creates the Space (space_test) we deploy into; its git
  // Installation is unrelated to the upload Installation under test.
  await seedInstallationModel(store, { environment: "preview" });
  const sources = new SourcesService({
    store,
    now: () => new Date("2026-06-09T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_upload`,
    readCapsuleSourceFiles: () =>
      Promise.resolve([{ path: "main.tf", text: READY_CAPSULE }]),
  });
  const installations = new InstallationsService({ store });
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    sourcesService: sources,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });
  await store.putConnection({
    id: "conn_upload_cf",
    spaceId: "space_test",
    scope: "space",
    provider: "cloudflare",
    kind: "cloudflare_api_token",
    authMethod: "static_secret",
    status: "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
    verifiedAt: "2026-06-09T00:00:00.000Z",
  });
  await store.putProviderEnv({
    id: "penv_upload_cf",
    spaceId: "space_test",
    providerSource: CLOUDFLARE_PROVIDER,
    displayName: "Cloudflare upload env",
    materialization: "secret",
    status: "ready",
    requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
    secretRef: "conn_upload_cf",
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
  });
  return { store, runner, sources, installations, controller };
}

test("deployUpload creates a source-less Installation and plans the upload snapshot", async () => {
  const { store, runner, sources, installations, controller } = await setup();
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

  const result = await deployUpload(
    { installations, controller },
    {
      spaceId: "space_test",
      name: "uploaded-app",
      environment: "preview",
      snapshotId: snapshot.id,
      vars: { region: "ap-northeast-1" },
      providerEnvBindings: UPLOAD_PROVIDER_CONNECTIONS,
    },
  );

  expect(result.created).toBe(true);
  expect(result.installation.sourceId).toBeUndefined();
  expect(result.installation.status).toBe("active");
  expect(result.run.type).toBe("plan");
  expect(result.run.status).toBe("succeeded");

  // The runner received the UPLOAD archive (no git clone).
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]?.sourceArchive).toEqual({
    objectKey: uploadArchiveObjectKey("space_test", "snap_up1"),
    digest: UPLOAD_DIGEST,
  });

  // A Capsule Gate report was pinned to the upload installation.
  const installation = await store.getInstallation(result.installation.id);
  expect(installation?.sourceId).toBeUndefined();
  expect(installation?.compatibilityReportId).toBeDefined();
});

test("deployUpload marks a new upload Installation error when orchestration throws", async () => {
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

  const created = (await installations.listInstallations("space_test")).find(
    (installation) =>
      installation.name === "timeout-app" &&
      installation.environment === "preview",
  );
  expect(created?.sourceId).toBeUndefined();
  expect(created?.status).toBe("error");
});

test("upload-origin Installation destroy-plan reuses the active Deployment SourceSnapshot", async () => {
  const { runner, sources, installations, controller } = await setup();
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
  const applyRun = deploy.applyRun;
  if (!applyRun || applyRun.status !== "succeeded") {
    throw new Error("upload deploy fixture did not auto-apply");
  }

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
  const applyRun = deploy.applyRun;
  if (!applyRun || applyRun.status !== "succeeded") {
    throw new Error("upload deploy fixture did not auto-apply");
  }
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
  expect(r1.created).toBe(true);

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
      vars: { changed: "yes" },
    },
  );
  expect(r2.created).toBe(false);
  expect(r2.installation.id).toBe(r1.installation.id);
});

test("deployUpload rejects provider env bindings without envId before persistence", async () => {
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
    message: expect.stringContaining("providerEnvBindings[0].envId"),
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

test("deployUpload rejects a snapshot that is not an upload snapshot", async () => {
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
