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
} from "./mod.ts";
import { OpenTofuDeploymentController } from "./mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "./store.ts";
import { SourcesService, uploadArchiveObjectKey } from "../sources/mod.ts";
import { InstallationsService } from "../installations/mod.ts";
import { CredentialBundle, PhaseMintBundle } from "../../adapters/vault/mod.ts";
import { seedInstallationModel } from "./test_model_fixture.ts";
import { deployUpload } from "./upload_deploy.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const STATE_DIGEST =
  "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const UPLOAD_DIGEST =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CLOUDFLARE_PROVIDER = "registry.opentofu.org/cloudflare/cloudflare";
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
      return Promise.resolve({ outputs: {} as never, stateDigest: STATE_DIGEST });
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
    mintForProviderBindings: () =>
      Promise.resolve(
        new CredentialBundle(
          { TF_VAR_cloudflare_main_api_token: "fixture-provider-token" },
          [],
          [{ ...evidence, delivery: "generated_root_variable", rootOnly: true }],
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
    },
  );

  expect(result.created).toBe(true);
  expect(result.installation.sourceId).toBeUndefined();
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
    { spaceId: "space_test", name: "iter", environment: "preview", snapshotId: first.id },
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
