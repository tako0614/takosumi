/**
 * Installation-driven run integration tests (Core Specification §19 / §20 / §21
 * / §23).
 *
 * The Space-direct model replaced the App/Environment/InstallProfile lanes: a
 * run targets an existing Installation (seeded via `seedInstallationModel`), and
 * the controller EMITS the dispatch fields the OpenTofu runner DO consumes.
 * These tests assert, via a recording runner, that an installation-driven
 * plan/apply/destroy carries `stateScope { spaceId, installationId, environment,
 * generation }` + `sourceArchive { objectKey, digest }` at the correct
 * generations, that a missing snapshot is a typed `source_sync_required` 409,
 * that a destroy-plan lands waiting_approval, that apply persists state at
 * base+1 and records a StateSnapshot (new R2_STATE keys) + Deployment (§21
 * shape) + marks the Installation active with a bumped generation, that destroy
 * (after approval) persists at base+1 and marks the Installation destroyed, that
 * a second plan reads the bumped generation, and the security invariants: a
 * changed/missing SourceSnapshot at apply is failed_precondition and a stale
 * plan (generation moved) is state_generation_mismatch.
 */

import { expect, test } from "bun:test";
import type {
  OpenTofuApplyJob,
  OpenTofuDestroyJob,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRunner,
} from "./mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuControllerError,
  OpenTofuDeploymentController,
} from "./mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "./store.ts";
import type { OpenTofuDeploymentStore } from "./store.ts";
import { SourcesService } from "../sources/mod.ts";
import { MemoryObjectStorage } from "../../adapters/object-storage/mod.ts";
import {
  CredentialBundle,
  PhaseMintBundle,
} from "../../adapters/vault/mod.ts";
import type {
  PlanRun,
  PlanResourceChange,
} from "@takosumi/internal/deploy-control-api";
import {
  FIXTURE_ARCHIVE_DIGEST,
  seedInstallationModel,
  type SeedModelOptions,
} from "./test_model_fixture.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const STATE_DIGEST =
  "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
// The fixture archives the snapshot under this object key (snapshotId snap_fixture).
const ARCHIVE_KEY =
  "spaces/space_test/sources/src_fixture/snapshots/snap_fixture/source.tar.zst";
const CLOUDFLARE_MIRROR_EVIDENCE = {
  provider: "registry.opentofu.org/cloudflare/cloudflare",
  mirrored: true,
  installationMethod: "filesystem_mirror",
  attested: true,
  attestationMethod: "forced_filesystem_mirror_init",
  mirrorPath:
    "/opt/opentofu/provider-mirror/registry.opentofu.org/cloudflare/cloudflare",
} as const;

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
        requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
        ...planResult,
      });
    },
    apply: (job) => {
      applyJobs.push(job);
      return Promise.resolve({
        // `launch_url` is a well-known DeploymentOutput kind so the public
        // projection publishes it. `bucket_name` is a generic non-sensitive
        // output that only flows to spaceOutputs when allowlisted. `admin_token` is
        // sensitive-flagged: it must appear in NEITHER projection (invariants
        // 11/12).
        outputs: {
          launch_url: { sensitive: false, value: "https://x.example" },
          public_url: { sensitive: false, value: "https://public.example" },
          bucket_name: { sensitive: false, value: "my-bucket" },
          admin_token: { sensitive: true, value: "super-secret-token" },
        } as never,
        stateDigest: STATE_DIGEST,
        rawOutputsKey:
          "spaces/space_test/installations/inst_fixture/runs/apply_0007/outputs.raw.json.enc",
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
      });
    },
    destroy: (job) => {
      destroyJobs.push(job);
      return Promise.resolve({
        providerInstallation: [CLOUDFLARE_MIRROR_EVIDENCE],
      });
    },
  };
}

function controllerWith(
  store: OpenTofuDeploymentStore,
  runner: OpenTofuRunner,
): OpenTofuDeploymentController {
  return new OpenTofuDeploymentController({
    store,
    runner,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });
}

function fakeProviderVault() {
  return {
    register: () => Promise.reject(new Error("not used")),
    test: () => Promise.resolve({ status: "verified" }),
    revoke: () => Promise.resolve(true),
    mint: () =>
      Promise.resolve(
        new CredentialBundle(
          { CLOUDFLARE_API_TOKEN: "fixture-provider-token" },
          [],
          [
            {
              provider: "registry.opentofu.org/cloudflare/cloudflare",
              connectionId: "fixture",
              delivery: "provider_env",
              rootOnly: false,
              temporary: true,
              ttlEnforced: true,
              phase: "plan",
            },
          ],
        ),
      ),
    mintForPhase: () =>
      Promise.resolve(
        new PhaseMintBundle(
          { env: { CLOUDFLARE_API_TOKEN: "fixture-provider-token" } },
          [],
          [
            {
              provider: "registry.opentofu.org/cloudflare/cloudflare",
              connectionId: "fixture",
              delivery: "provider_env",
              rootOnly: false,
              temporary: true,
              ttlEnforced: true,
              phase: "plan",
            },
          ],
        ),
      ),
    mintForProviderBindings: () =>
      Promise.resolve(
        new CredentialBundle(
          {
            TF_VAR_cloudflare_main_api_token: "fixture-provider-token",
          },
          [],
          [
            {
              provider: "registry.opentofu.org/cloudflare/cloudflare",
              connectionId: "fixture",
              delivery: "generated_root_variable",
              rootOnly: true,
              temporary: true,
              ttlEnforced: true,
              phase: "plan",
            },
          ],
        ),
      ),
  };
}

function countingProviderVault() {
  let mintCount = 0;
  const vault = {
    register: () => Promise.reject(new Error("not used")),
    test: () => Promise.resolve({ status: "verified" }),
    revoke: () => Promise.resolve(true),
    mint: () => {
      mintCount += 1;
      return Promise.resolve(
        new CredentialBundle(
          { CLOUDFLARE_API_TOKEN: "fixture-provider-token" },
          [],
          [
            {
              provider: "registry.opentofu.org/cloudflare/cloudflare",
              connectionId: "fixture",
              delivery: "provider_env" as const,
              rootOnly: false,
              temporary: true,
              ttlEnforced: true,
              phase: "plan" as const,
            },
          ],
        ),
      );
    },
    mintForPhase: () => {
      mintCount += 1;
      return Promise.resolve(
        new PhaseMintBundle(
          { env: { CLOUDFLARE_API_TOKEN: "fixture-provider-token" } },
          [],
          [
            {
              provider: "registry.opentofu.org/cloudflare/cloudflare",
              connectionId: "fixture",
              delivery: "provider_env" as const,
              rootOnly: false,
              temporary: true,
              ttlEnforced: true,
              phase: "plan" as const,
            },
          ],
        ),
      );
    },
    mintForProviderBindings: () => {
      mintCount += 1;
      return Promise.resolve(
        new CredentialBundle(
          {
            TF_VAR_cloudflare_main_api_token: "fixture-provider-token",
          },
          [],
          [
            {
              provider: "registry.opentofu.org/cloudflare/cloudflare",
              connectionId: "fixture",
              delivery: "generated_root_variable" as const,
              rootOnly: true,
              temporary: true,
              ttlEnforced: true,
              phase: "plan" as const,
            },
          ],
        ),
      );
    },
  };
  return {
    vault,
    get mintCount() {
      return mintCount;
    },
  };
}

/**
 * Seeds the Space-direct Installation model and returns a wired controller +
 * runner. Defaults to a `preview` environment so the no-approval apply path is
 * exercised; pass `environment: "production"` to land plans waiting_approval.
 */
async function seededController(options: SeedModelOptions = {}): Promise<{
  store: OpenTofuDeploymentStore;
  runner: RecordingRunner;
  controller: OpenTofuDeploymentController;
}> {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedInstallationModel(store, { environment: "preview", ...options });
  const controller = controllerWith(store, runner);
  return { store, runner, controller };
}

test("installation plan dispatch carries sourceArchive + stateScope at the current generation", async () => {
  const { runner, controller } = await seededController();

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.sourceSnapshotId).toEqual("snap_fixture");
  expect(planRun.installationContext).toEqual({
    spaceId: "space_test",
    installationId: "inst_fixture",
    environment: "preview",
  });
  // First plan: no prior StateSnapshot -> base generation 0.
  expect(planRun.baseStateGeneration).toEqual(0);

  expect(runner.planJobs).toHaveLength(1);
  const job = runner.planJobs[0]!;
  expect(job.sourceArchive).toEqual({
    objectKey: ARCHIVE_KEY,
    digest: FIXTURE_ARCHIVE_DIGEST,
  });
  // Plan restores against the CURRENT generation (0).
  expect(job.stateScope).toEqual({
    spaceId: "space_test",
    installationId: "inst_fixture",
    environment: "preview",
    generation: 0,
  });
  expect(job.template).toBeUndefined();
  expect(job.generatedRoot?.files["main.tf"]).toContain('module "app"');
  expect(job.generatedRoot?.files["main.tf"]).toContain(
    'source = "./template-module"',
  );
  expect(job.generatedRoot?.files["versions.tf"]).toContain(
    "required_providers",
  );

  // The unified Run facade projects the installation context.
  const run = await controller.getRun(planRun.id);
  expect(run.installationId).toEqual("inst_fixture");
  expect(run.environment).toEqual("preview");
  expect(run.sourceSnapshotId).toEqual("snap_fixture");
  expect(run.baseStateGeneration).toEqual(0);
});

test("installation queued plan fails before credential mint when generated-root sidecar is missing", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, { environment: "preview" });
  await store.putConnection({
    id: "conn_missing_sidecar",
    scope: "space",
    spaceId: seeded.installation.spaceId,
    provider: "cloudflare",
    kind: "cloudflare_api_token",
    displayName: "Missing sidecar Cloudflare",
    status: "verified",
    scopeJson: {},
    now: sequenceNow(1),
    newId: deterministicIds(),
  });
  await store.putDeploymentProfile({
    id: "profile_missing_sidecar",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [{ provider: "cloudflare", alias: "main", mode: "connection", connectionId: "conn_missing_sidecar" }],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const counted = countingProviderVault();
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    vault: counted.vault as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
    enqueueRun: () => Promise.resolve(),
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toBe("queued");
  expect(await store.getPlanRunInputs(planRun.id)).toBeDefined();

  await store.deletePlanRunInputs(planRun.id);
  const failed = await controller.runQueuedPlan(planRun.id);

  expect(failed?.status).toBe("failed");
  expect(failed?.diagnostics?.[0]?.message).toContain(
    "generated_root_sidecar_missing",
  );
  expect(counted.mintCount).toBe(0);
  expect(runner.planJobs).toHaveLength(0);
});

test("installation plan verifies CompatibilityReport before provider credential mint", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, { environment: "preview" });
  await store.putCapsuleCompatibilityReport({
    id: "caprep_needs_patch",
    sourceId: seeded.source.id,
    sourceSnapshotId: seeded.snapshot.id,
    level: "needs_patch",
    findings: [
      {
        severity: "warning",
        code: "provider_credentials_in_source",
        message: "provider credentials are configured in source",
      },
    ],
    providers: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    normalizedObjectKey: seeded.snapshot.archiveObjectKey,
    normalizedDigest: seeded.snapshot.archiveDigest,
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putInstallation({
    ...seeded.installation,
    compatibilityReportId: "caprep_needs_patch",
    compatibilityStatus: "needs_patch",
  });
  const controller = controllerWith(store, runner);

  await expect(
    controller.createInstallationPlan("inst_fixture"),
  ).rejects.toThrow("compatibility_report_not_runnable");
  expect(runner.planJobs).toHaveLength(0);
});

test("installation CompatibilityReport gate honors InstallConfig resource policy", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      policy: {
        allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
        allowedResourceTypes: ["cloudflare_workers_script"],
        allowedDataSourceTypes: ["external"],
        allowedProvisionerTypes: ["local-exec"],
      },
    },
  });
  await store.putCapsuleCompatibilityReport({
    id: "caprep_policy_allowed_resource",
    sourceId: seeded.source.id,
    sourceSnapshotId: seeded.snapshot.id,
    level: "unsupported",
    findings: [
      {
        severity: "error",
        code: "resource_type_not_allowed",
        message:
          "Resource type cloudflare_workers_script is not allowed by default policy.",
      },
      {
        severity: "error",
        code: "external_data_source_unsupported",
        message: "Data source external is not allowed by default policy.",
      },
      {
        severity: "error",
        code: "provisioner_unsupported",
        message: "Provisioner local-exec is not allowed by default policy.",
      },
    ],
    providers: [
      {
        source: "cloudflare/cloudflare",
        aliases: [],
        allowed: true,
      },
    ],
    resources: [
      {
        type: "cloudflare_workers_script",
        count: 1,
        allowed: false,
      },
    ],
    dataSources: [{ type: "external", allowed: false }],
    provisioners: [{ type: "local-exec", allowed: false }],
    normalizedObjectKey: seeded.snapshot.archiveObjectKey,
    normalizedDigest: seeded.snapshot.archiveDigest,
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putInstallation({
    ...seeded.installation,
    compatibilityReportId: "caprep_policy_allowed_resource",
    compatibilityStatus: "unsupported",
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toEqual("succeeded");
  expect(runner.planJobs).toHaveLength(1);
  expect(planRun.policy.reasons.join("\n")).not.toContain(
    "compatibility_report_not_runnable",
  );
});

test("installation plan creates and pins a CompatibilityReport when SourcesService is wired", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedInstallationModel(store, { environment: "preview" });
  const sourcesService = new SourcesService({
    store,
    now: () => new Date("2026-06-07T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_compat_auto`,
    readCapsuleSourceFiles: () =>
      Promise.resolve([
        {
          path: "main.tf",
          text: `
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
`,
        },
      ]),
  });
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    sourcesService,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toBe("succeeded");
  expect(planRun.compatibilityReportId).toBe("caprep_compat_auto");
  const installation = await store.getInstallation("inst_fixture");
  expect(installation?.compatibilityReportId).toBe("caprep_compat_auto");
  expect(installation?.compatibilityStatus).toBe("ready");
  expect(runner.planJobs).toHaveLength(1);
});

test("installation plan dispatches normalized module files for auto-capsulized CompatibilityReport", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedInstallationModel(store, { environment: "preview" });
  const objectStorage = new MemoryObjectStorage({
    clock: () => new Date("2026-06-07T00:00:00.000Z"),
  });
  const sourcesService = new SourcesService({
    store,
    normalizedArtifactStorage: objectStorage,
    now: () => new Date("2026-06-07T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_compat_auto`,
    readCapsuleSourceFiles: () =>
      Promise.resolve([
        {
          path: "main.tf",
          text: `
terraform {
  backend "s3" {}
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

provider "aws" {
  region = "ap-northeast-1"
}

output "attachments_bucket" {
  value = "attachments"
}
`,
        },
      ]),
  });
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    sourcesService,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toBe("succeeded");
  expect(planRun.compatibilityReportId).toBe("caprep_compat_auto");
  const report =
    await store.getCapsuleCompatibilityReport("caprep_compat_auto");
  expect(report?.level).toBe("auto_capsulized");
  expect(report?.normalizedObjectKey).toBe(
    "spaces/space_test/sources/src_fixture/snapshots/snap_fixture/normalized-module.json",
  );
  expect(report?.normalizedDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]?.sourceArchive).toEqual({
    objectKey: ARCHIVE_KEY,
    digest: FIXTURE_ARCHIVE_DIGEST,
  });
  const moduleFiles = runner.planJobs[0]?.generatedRoot?.moduleFiles;
  expect(moduleFiles?.map((file) => file.path)).toEqual(["main.tf"]);
  expect(moduleFiles?.[0]?.text).not.toContain('backend "s3"');
  expect(moduleFiles?.[0]?.text).not.toContain('provider "aws"');
});

test("installation plan records runnable CompatibilityReport in policy audit", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, { environment: "preview" });
  await store.putCapsuleCompatibilityReport({
    id: "caprep_ready",
    sourceId: seeded.source.id,
    sourceSnapshotId: seeded.snapshot.id,
    level: "ready",
    findings: [
      {
        severity: "warning",
        code: "outputs_missing",
        message: "No output blocks were detected.",
      },
    ],
    providers: [
      {
        source: "cloudflare/cloudflare",
        aliases: [],
        allowed: true,
      },
    ],
    resources: [],
    dataSources: [],
    provisioners: [],
    normalizedObjectKey: seeded.snapshot.archiveObjectKey,
    normalizedDigest: seeded.snapshot.archiveDigest,
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putInstallation({
    ...seeded.installation,
    compatibilityReportId: "caprep_ready",
    compatibilityStatus: "ready",
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toBe("succeeded");
  expect(planRun.policy.status).toBe("passed");
  expect(planRun.policy.reasons).toEqual([]);
  const policyEvents = planRun.auditEvents.filter(
    (event) => event.type === "plan.policy_evaluated",
  );
  expect(policyEvents.at(-1)?.data?.capsuleCompatibility).toEqual({
    reportId: "caprep_ready",
    level: "ready",
    findingCount: 1,
    infoCount: 0,
    warningCount: 1,
    errorCount: 0,
  });
});

test("generic Capsule installation plan derives pre-init requiredProviders from CompatibilityReport providers", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, { environment: "preview" });
  await store.putCapsuleCompatibilityReport({
    id: "caprep_providers",
    sourceId: seeded.source.id,
    sourceSnapshotId: seeded.snapshot.id,
    level: "ready",
    findings: [],
    providers: [
      {
        source: "registry.opentofu.org/hashicorp/aws",
        aliases: [],
        allowed: true,
      },
    ],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putInstallation({
    ...seeded.installation,
    compatibilityReportId: "caprep_providers",
    compatibilityStatus: "ready",
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.requiredProviders).toEqual([
    "registry.opentofu.org/cloudflare/cloudflare",
  ]);
  expect(runner.planJobs[0]?.planRun.requiredProviders).toEqual([
    "registry.opentofu.org/cloudflare/cloudflare",
  ]);
});

test("a no-connection install mints the operator default for its required provider (managed by default §7.1)", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, { environment: "preview" });
  // Operator default: the managed key a beginner install resolves to with NO
  // Space connection and NO explicit provider binding (the panpii path).
  await store.putConnection({
    id: "conn_op_cf",
    scope: "operator",
    provider: "cloudflare",
    kind: "cloudflare_api_token",
    authMethod: "static_secret",
    status: "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putOperatorConnectionDefault({
    id: "ocd_cf",
    provider: "cloudflare",
    connectionId: "conn_op_cf",
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  const report = {
    id: "caprep_managed",
    sourceId: seeded.source.id,
    sourceSnapshotId: seeded.snapshot.id,
    level: "ready" as const,
    findings: [],
    providers: [{ source: "cloudflare/cloudflare", aliases: [], allowed: true }],
    resources: [],
    dataSources: [],
    provisioners: [],
    normalizedObjectKey: seeded.snapshot.archiveObjectKey,
    normalizedDigest: seeded.snapshot.archiveDigest,
    createdAt: "2026-06-07T00:00:00.000Z",
  };
  await store.putCapsuleCompatibilityReport(report);
  await store.putInstallation({
    ...seeded.installation,
    compatibilityReportId: report.id,
    compatibilityStatus: "ready",
  });
  // NOTE: no DeploymentProfile is created, so the install configures NO bindings
  // and NO Space connection — the operator-default fall-through is the only path
  // that can supply a provider credential here.

  // Recording vault: capture the per-binding mint entries so the test proves the
  // operator default connection reached the credential mint.
  const mintEntries: { provider: string; connectionId: string }[] = [];
  const vault = {
    register: () => Promise.reject(new Error("not used")),
    test: () => Promise.resolve({ status: "verified" as const }),
    revoke: () => Promise.resolve(true),
    mint: () => Promise.resolve(new CredentialBundle({})),
    mintForPhase: () => Promise.resolve(new PhaseMintBundle({ env: {} })),
    mintForProviderBindings: (
      _spaceId: string,
      entries: readonly { provider: string; connectionId: string }[],
    ) => {
      for (const entry of entries) {
        mintEntries.push({
          provider: entry.provider,
          connectionId: entry.connectionId,
        });
      }
      return Promise.resolve(
        new CredentialBundle(
          { TF_VAR_cloudflare_api_token: "operator-key-token" },
          [],
          [
            {
              // The managed cloudflare default vends a TEMPORARY token (the
              // cloudflare-default runner profile policy rejects static creds),
              // so the evidence is temporary + ttl-enforced.
              provider: "registry.opentofu.org/cloudflare/cloudflare",
              connectionId: "conn_op_cf",
              delivery: "generated_root_variable" as const,
              rootOnly: true,
              temporary: true,
              ttlEnforced: true,
              expiresAt: "2026-06-07T01:00:00.000Z",
              ttlSeconds: 3600,
              phase: "plan" as const,
            },
          ],
        ),
      );
    },
  };
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    vault: vault as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toEqual("succeeded");
  // The managed default (operator key) was minted for the required provider,
  // keyed by the operator default's own connection id, with NO Space connection
  // and NO explicit binding — proving the documented "empty -> default" contract
  // end-to-end through the controller.
  expect(mintEntries).toEqual([
    { provider: "cloudflare", connectionId: "conn_op_cf" },
  ]);
});

test("generic Capsule plan creation blocks stale CompatibilityReport as policy", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, { environment: "preview" });
  await store.putCapsuleCompatibilityReport({
    id: "caprep_stale",
    sourceId: seeded.source.id,
    sourceSnapshotId: "snap_old",
    level: "ready",
    findings: [],
    providers: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putInstallation({
    ...seeded.installation,
    compatibilityReportId: "caprep_stale",
    compatibilityStatus: "ready",
  });
  const controller = controllerWith(store, runner);

  await expect(
    controller.createInstallationPlan(seeded.installation.id),
  ).rejects.toThrow("compatibility_report_stale");
  expect(runner.planJobs).toHaveLength(0);
});

test("installation apply revalidates CompatibilityReport before provider credential mint", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, { environment: "preview" });
  const report = {
    id: "caprep_apply_guard",
    sourceId: seeded.source.id,
    sourceSnapshotId: seeded.snapshot.id,
    level: "ready" as const,
    findings: [],
    providers: [
      {
        source: "cloudflare/cloudflare",
        aliases: [],
        allowed: true,
      },
    ],
    resources: [],
    dataSources: [],
    provisioners: [],
    normalizedObjectKey: seeded.snapshot.archiveObjectKey,
    normalizedDigest: seeded.snapshot.archiveDigest,
    createdAt: "2026-06-07T00:00:00.000Z",
  };
  await store.putCapsuleCompatibilityReport(report);
  await store.putInstallation({
    ...seeded.installation,
    compatibilityReportId: report.id,
    compatibilityStatus: "ready",
  });
  await store.putConnection({
    id: "conn_apply_guard",
    scope: "space",
    spaceId: seeded.installation.spaceId,
    provider: "cloudflare",
    kind: "cloudflare_api_token",
    displayName: "Apply guard Cloudflare",
    status: "verified",
    scopeJson: {},
    secretRef: "sec_apply_guard",
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putDeploymentProfile({
    id: "profile_apply_guard",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [{ provider: "cloudflare", alias: "main", mode: "connection", connectionId: "conn_apply_guard" }],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  const counted = countingProviderVault();
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    vault: counted.vault as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toBe("succeeded");
  const mintCountAfterPlan = counted.mintCount;
  expect(mintCountAfterPlan).toBeGreaterThan(0);

  await store.putCapsuleCompatibilityReport({
    ...report,
    level: "needs_patch",
    findings: [
      {
        severity: "warning",
        code: "provider_credentials_in_source",
        message: "provider credentials are configured in source",
      },
    ],
  });

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(applyRun.diagnostics?.[0]?.message).toContain(
    "compatibility_report_not_runnable",
  );
  expect(counted.mintCount).toBe(mintCountAfterPlan);
  expect(runner.applyJobs).toHaveLength(0);
});

test("installation apply fails before credential mint when generated-root sidecar is missing", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, { environment: "preview" });
  await store.putConnection({
    id: "conn_apply_missing_sidecar",
    scope: "space",
    spaceId: seeded.installation.spaceId,
    provider: "cloudflare",
    kind: "cloudflare_api_token",
    displayName: "Apply missing sidecar Cloudflare",
    status: "verified",
    scopeJson: {},
    now: sequenceNow(1),
    newId: deterministicIds(),
  });
  await store.putDeploymentProfile({
    id: "profile_apply_missing_sidecar",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [{ provider: "cloudflare", alias: "main", mode: "connection", connectionId: "conn_apply_missing_sidecar", }],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const counted = countingProviderVault();
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    vault: counted.vault as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toBe("succeeded");
  const mintCountAfterPlan = counted.mintCount;
  expect(mintCountAfterPlan).toBeGreaterThan(0);

  await store.deletePlanRunInputs(planRun.id);
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(applyRun.diagnostics?.[0]?.message).toContain(
    "generated_root_sidecar_missing",
  );
  expect(counted.mintCount).toBe(mintCountAfterPlan);
  expect(runner.applyJobs).toHaveLength(0);
});

test("installation plan blocks when provider lockfile digest is required but missing", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner({ providerLockDigest: undefined });
  await seedInstallationModel(store, {
    installConfig: {
      policy: {
        providerLockfile: { requireDigest: true },
      },
    },
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(runner.planJobs).toHaveLength(1);
  expect(planRun.status).toBe("blocked");
  expect(planRun.policy.status).toBe("blocked");
  expect(planRun.policy.reasons.join("\n")).toContain(
    "provider lockfile digest is required by policy",
  );
  const policyEvents = planRun.auditEvents.filter(
    (event) => event.type === "plan.policy_evaluated",
  );
  expect(policyEvents.at(-1)?.data?.providerLockfileDigestPresent).toBe(false);
});

test("installation plan blocks when provider mirror evidence is required but missing", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner({ providerInstallation: undefined });
  await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      policy: {
        providerInstallation: { requireMirror: true },
      },
    },
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(runner.planJobs).toHaveLength(1);
  expect(planRun.status).toBe("blocked");
  expect(planRun.policy.reasons.join("\n")).toContain(
    "provider installation attestation is required by policy",
  );
  const policyEvents = planRun.auditEvents.filter(
    (event) => event.type === "plan.policy_evaluated",
  );
  expect(policyEvents.at(-1)?.data).toMatchObject({
    providerMirrorRequired: true,
    providerMirrorPassed: false,
    providerMirrorEvidenceCount: 0,
  });
});

test("installation plan requires provider mirror evidence by default when providers are used", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner({
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    providerInstallation: undefined,
  });
  await seedInstallationModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(runner.planJobs[0]?.providerInstallationPolicy).toEqual({
    requireMirror: true,
  });
  expect(planRun.status).toBe("blocked");
  expect(planRun.policy.reasons.join("\n")).toContain(
    "provider installation attestation is required by policy",
  );
});

test("installation plan enforces filesystem mirror evidence for every required provider", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner({
    requiredProviders: [
      "registry.opentofu.org/cloudflare/cloudflare",
      "registry.opentofu.org/hashicorp/aws",
    ],
    providerInstallation: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        mirrored: true,
        installationMethod: "filesystem_mirror",
        attested: true,
        attestationMethod: "forced_filesystem_mirror_init",
        mirrorPath:
          "/opt/opentofu/provider-mirror/registry.opentofu.org/cloudflare/cloudflare",
      },
      {
        provider: "registry.opentofu.org/hashicorp/aws",
        mirrored: false,
        installationMethod: "direct",
        mirrorPath:
          "/opt/opentofu/provider-mirror/registry.opentofu.org/hashicorp/aws",
      },
    ],
  });
  await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      policy: {
        allowedProviders: [
          "registry.opentofu.org/cloudflare/cloudflare",
          "registry.opentofu.org/hashicorp/aws",
        ],
        providerInstallation: { requireMirror: true },
      },
    },
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toBe("blocked");
  expect(planRun.policy.reasons.join("\n")).toContain(
    "registry.opentofu.org/hashicorp/aws",
  );
  expect(planRun.policy.reasons.join("\n")).not.toContain(
    "registry.opentofu.org/cloudflare/cloudflare, registry.opentofu.org/hashicorp/aws",
  );
  const policyEvents = planRun.auditEvents.filter(
    (event) => event.type === "plan.policy_evaluated",
  );
  expect(policyEvents.at(-1)?.data).toMatchObject({
    providerMirrorRequired: true,
    providerMirrorPassed: false,
    providerMirrorEvidenceCount: 2,
  });
});

test("installation plan blocks when mirror evidence omits a required provider", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner({
    requiredProviders: [
      "registry.opentofu.org/cloudflare/cloudflare",
      "registry.opentofu.org/hashicorp/aws",
    ],
    providerInstallation: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        mirrored: true,
        installationMethod: "filesystem_mirror",
        attested: true,
        attestationMethod: "forced_filesystem_mirror_init",
        mirrorPath:
          "/opt/opentofu/provider-mirror/registry.opentofu.org/cloudflare/cloudflare",
      },
    ],
  });
  await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      policy: {
        allowedProviders: [
          "registry.opentofu.org/cloudflare/cloudflare",
          "registry.opentofu.org/hashicorp/aws",
        ],
        providerInstallation: { requireMirror: true },
      },
    },
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toBe("blocked");
  expect(planRun.policy.reasons.join("\n")).toContain(
    "provider installation attestation is missing for required providers: registry.opentofu.org/hashicorp/aws",
  );
});

test("installation plan blocks when mirror evidence is not actual install attestation", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner({
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    providerInstallation: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        mirrored: true,
        installationMethod: "filesystem_mirror",
        mirrorPath:
          "/opt/opentofu/provider-mirror/registry.opentofu.org/cloudflare/cloudflare",
      },
    ],
  });
  await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      policy: {
        allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
        providerInstallation: { requireMirror: true },
      },
    },
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toBe("blocked");
  expect(planRun.policy.reasons.join("\n")).toContain(
    "not attested as installed from the filesystem mirror",
  );
});

test("mirror-required policy is dispatched to plan and apply runner jobs", async () => {
  const { runner, controller } = await seededController({
    installConfig: {
      policy: {
        allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
        providerInstallation: { requireMirror: true },
      },
    },
  });
  runner.plan = (job) => {
    runner.planJobs.push(job);
    return Promise.resolve({
      planDigest: PLAN_DIGEST,
      planArtifact: {
        kind: "runner-local",
        ref: "runner-local://plan/tfplan",
        digest: PLAN_DIGEST,
        contentType: "application/vnd.opentofu.plan",
      },
      providerLockDigest: LOCK_DIGEST,
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
      providerInstallation: [
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          mirrored: true,
          installationMethod: "filesystem_mirror",
          attested: true,
          attestationMethod: "forced_filesystem_mirror_init",
          mirrorPath:
            "/opt/opentofu/provider-mirror/registry.opentofu.org/cloudflare/cloudflare",
        },
      ],
    });
  };

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toBe("succeeded");
  expect(runner.planJobs[0]?.providerInstallationPolicy).toEqual({
    requireMirror: true,
  });

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect(runner.applyJobs[0]?.providerInstallationPolicy).toEqual({
    requireMirror: true,
  });
  const applyProviderEvent = applyRun.auditEvents.find(
    (event) => event.type === "apply.provider_installation_evaluated",
  );
  expect(applyProviderEvent?.data).toMatchObject({
    requireMirror: true,
    evidenceCount: 1,
    mirroredCount: 1,
    attestedCount: 1,
  });
});

/**
 * Seeds the operator-default (managed key) path: an operator-scoped Cloudflare
 * Connection registered as the instance-wide default for `cloudflare`, with NO
 * Space DeploymentProfile, so a run's required cloudflare provider falls through
 * to the operator default (§7.1). Returns a controller carrying the given
 * managed-default apply cap.
 */
async function seededManagedDefaultController(options: {
  readonly managedDefaultApplyCap?: number;
}): Promise<{
  store: InMemoryOpenTofuDeploymentStore;
  controller: OpenTofuDeploymentController;
}> {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, { environment: "preview" });
  await store.putConnection({
    id: "conn_op_cf",
    scope: "operator",
    provider: "cloudflare",
    kind: "cloudflare_api_token",
    authMethod: "static_secret",
    status: "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  } as never);
  await store.putOperatorConnectionDefault({
    id: "ocd_cf",
    provider: "cloudflare",
    connectionId: "conn_op_cf",
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  const report = {
    id: "caprep_managed",
    sourceId: seeded.source.id,
    sourceSnapshotId: seeded.snapshot.id,
    level: "ready" as const,
    findings: [],
    providers: [{ source: "cloudflare/cloudflare", aliases: [], allowed: true }],
    resources: [],
    dataSources: [],
    provisioners: [],
    normalizedObjectKey: seeded.snapshot.archiveObjectKey,
    normalizedDigest: seeded.snapshot.archiveDigest,
    createdAt: "2026-06-07T00:00:00.000Z",
  };
  await store.putCapsuleCompatibilityReport(report);
  await store.putInstallation({
    ...seeded.installation,
    compatibilityReportId: report.id,
    compatibilityStatus: "ready",
  });
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
    ...(options.managedDefaultApplyCap !== undefined
      ? { managedDefaultApplyCap: options.managedDefaultApplyCap }
      : {}),
  });
  return { store, controller };
}

test("managed-default apply cap rejects apply once a Space reaches the operator-key ceiling (P2)", async () => {
  const { store, controller } = await seededManagedDefaultController({
    managedDefaultApplyCap: 2,
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toBe("succeeded");

  // Simulate two prior successful write-applies on the operator key: each apply
  // bumps the Installation's currentStateGeneration by one, so a cumulative
  // generation of 2 means the Space has already used its 2-apply ceiling.
  const installation = await store.getInstallation("inst_fixture");
  await store.putInstallation({ ...installation!, currentStateGeneration: 2 });

  await expect(
    controller.createApplyRun({
      planRunId: planRun.id,
      expected: applyExpectedGuardFromPlanRun(planRun),
    }),
  ).rejects.toThrow("managed_apply_cap_reached");
});

test("managed-default apply cap never blocks a destroy — teardown stops spend (P2)", async () => {
  const { controller } = await seededManagedDefaultController({
    managedDefaultApplyCap: 1,
  });

  // First create-apply on the operator key is admitted (cumulative 0 < cap 1)
  // and brings the Space to the cap (generation 1).
  const create = await controller.createInstallationPlan("inst_fixture");
  const created = await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });
  expect(created.applyRun.status).toBe("succeeded");

  // At the cap a further create/update apply would be rejected — but a destroy
  // is the way to STOP spending on the operator key, so it must still apply
  // (after the mandatory approval). Capping teardown would trap the Space.
  const destroy = await controller.createInstallationDestroyPlan("inst_fixture");
  await controller.approveRun(destroy.planRun.id);
  const torn = await controller.createApplyRun({
    planRunId: destroy.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroy.planRun),
  });
  expect(torn.applyRun.status).toBe("succeeded");
});

test("managed-default apply cap admits apply while the Space is below the ceiling", async () => {
  const { store, controller } = await seededManagedDefaultController({
    managedDefaultApplyCap: 5,
  });

  // A sibling Installation in the SAME Space carries one prior apply
  // (generation 1). The cumulative count (1) is still below the cap of 5, so the
  // apply of inst_fixture (itself at generation 0, consistent with its plan)
  // proceeds. Counting a sibling proves the cap sums across the whole Space.
  const inst = await store.getInstallation("inst_fixture");
  await store.putInstallation({
    ...inst!,
    id: "inst_sibling",
    slug: "sibling",
    name: "sibling",
    currentStateGeneration: 1,
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toBe("succeeded");

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun.status).toBe("succeeded");
});

test("managed-default apply cap never caps a Space applying on its OWN Connection (self-host)", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, { environment: "preview" });
  // A Space-owned (self-host style) Connection bound explicitly: the run resolves
  // to mode "connection" with a SPACE-scoped Connection, never the operator key,
  // so even far past the cap the apply is admitted.
  await store.putConnection({
    id: "conn_self_cf",
    scope: "space",
    spaceId: seeded.installation.spaceId,
    provider: "cloudflare",
    kind: "cloudflare_api_token",
    displayName: "Self-host Cloudflare",
    status: "verified",
    scopeJson: {},
    secretRef: "sec_self_cf",
    createdAt: "2026-06-07T00:00:00.000Z",
  } as never);
  await store.putDeploymentProfile({
    id: "profile_self",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        mode: "connection",
        connectionId: "conn_self_cf",
      },
    ],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
    managedDefaultApplyCap: 1,
  });

  // A sibling Installation carries a cumulative count (generation 10) far past
  // the cap of 1, but inst_fixture's run binds the Space's OWN Connection (never
  // the operator key), so the cap does not apply and the apply is admitted.
  const inst = await store.getInstallation("inst_fixture");
  await store.putInstallation({
    ...inst!,
    id: "inst_sibling",
    slug: "sibling",
    name: "sibling",
    currentStateGeneration: 10,
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toBe("succeeded");

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun.status).toBe("succeeded");
});

test("showback billing records reservation and usage without blocking apply", async () => {
  const { store, controller } = await seededController();
  const space = await store.getSpace("space_test");
  await store.putSpace({
    ...space!,
    billingSettings: { mode: "showback", provider: "none" },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toBe("succeeded");
  const reservation = await store.getCreditReservationForRun(planRun.id);
  expect(reservation).toMatchObject({
    spaceId: "space_test",
    runId: planRun.id,
    estimatedCredits: 1,
    status: "reserved",
    mode: "showback",
  });

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect((await store.getCreditReservationForRun(planRun.id))?.status).toBe(
    "captured",
  );
  const usageEvents = await store.listUsageEvents("space_test");
  expect(usageEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        runId: planRun.id,
        kind: "runner_minute",
        credits: 1,
        source: "runner",
      }),
      expect.objectContaining({
        runId: applyRun.id,
        kind: "runner_minute",
        credits: 1,
        source: "runner",
      }),
      expect.objectContaining({
        runId: applyRun.id,
        kind: "operation",
        credits: 1,
        source: "runner",
      }),
    ]),
  );
  expect(usageEvents.filter((event) => event.kind === "runner_minute")).toEqual([
    expect.objectContaining({
      runId: planRun.id,
      quantity: expect.any(Number),
    }),
    expect.objectContaining({
      runId: applyRun.id,
      quantity: expect.any(Number),
    }),
  ]);
});

async function showbackEstimatedCreditsFor(
  planResourceChanges: readonly PlanResourceChange[],
): Promise<number> {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner({ planResourceChanges: [...planResourceChanges] });
  await seedInstallationModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner);
  const space = await store.getSpace("space_test");
  await store.putSpace({
    ...space!,
    billingSettings: { mode: "showback", provider: "none" },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toBe("succeeded");
  const reservation = await store.getCreditReservationForRun(planRun.id);
  expect(reservation).toBeDefined();
  return reservation!.estimatedCredits;
}

test("plan cost estimate falls back to BASE when the plan has no chargeable changes", async () => {
  // no-op / read only -> Σ weight = 0 -> max(BASE=1, 0) = 1.
  expect(
    await showbackEstimatedCreditsFor([
      { address: "a.one", type: "a", actions: ["no-op"] },
      { address: "b.two", type: "b", actions: ["read"] },
    ]),
  ).toBe(1);
  // Empty change set also pins to BASE.
  expect(await showbackEstimatedCreditsFor([])).toBe(1);
});

test("plan cost estimate sums create weights (create x3 -> 6)", async () => {
  expect(
    await showbackEstimatedCreditsFor([
      { address: "a.one", type: "a", actions: ["create"] },
      { address: "a.two", type: "a", actions: ["create"] },
      { address: "a.three", type: "a", actions: ["create"] },
    ]),
  ).toBe(6);
});

test("plan cost estimate weights a mixed plan and bills replace once as a create", async () => {
  // create(2) + update(1) + delete(1) + replace as ["delete","create"] -> max(1,2)=2
  // + no-op(0) = 6. Replace is NOT double-counted as create + delete.
  expect(
    await showbackEstimatedCreditsFor([
      { address: "a.create", type: "a", actions: ["create"] },
      { address: "a.update", type: "a", actions: ["update"] },
      { address: "a.delete", type: "a", actions: ["delete"] },
      { address: "a.replace", type: "a", actions: ["delete", "create"] },
      { address: "a.noop", type: "a", actions: ["no-op"] },
    ]),
  ).toBe(6);
});

test("enforced billing blocks plan when credits are insufficient", async () => {
  const { store, runner, controller } = await seededController();
  const space = await store.getSpace("space_test");
  await store.putSpace({
    ...space!,
    billingSettings: {
      mode: "enforce",
      provider: "manual",
      reservationRequired: true,
    },
  });
  await store.putCreditBalance({
    spaceId: "space_test",
    availableCredits: 0,
    reservedCredits: 0,
    monthlyIncludedCredits: 0,
    purchasedCredits: 0,
    updatedAt: "2026-06-07T00:00:00.000Z",
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(runner.planJobs).toHaveLength(1);
  expect(planRun.status).toBe("blocked");
  expect(planRun.policy.reasons.join("\n")).toContain(
    "credit reservation failed",
  );
  expect(await store.getCreditReservationForRun(planRun.id)).toBeUndefined();
});

test("enforced billing plan limits block oversized plans before reservation", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner({
    planResourceChanges: [
      {
        address: "cloudflare_workers_script.one",
        type: "cloudflare_workers_script",
        actions: ["create"],
      },
      {
        address: "cloudflare_dns_record.two",
        type: "cloudflare_dns_record",
        actions: ["create"],
      },
    ],
  });
  await seedInstallationModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner);
  const space = await store.getSpace("space_test");
  await store.putSpace({
    ...space!,
    billingSettings: {
      mode: "enforce",
      provider: "manual",
      reservationRequired: true,
    },
  });
  await store.putBillingPlan({
    id: "tiny",
    name: "Tiny",
    monthlyBasePrice: 0,
    includedCredits: 1,
    limits: { maxEstimatedCreditsPerRun: 1, quota: { resources: 1 } },
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putBillingAccount({
    id: "bill_space_test",
    ownerType: "space",
    ownerId: "space_test",
    provider: "manual",
    status: "active",
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putSpaceSubscription({
    id: "sub_tiny",
    spaceId: "space_test",
    billingAccountId: "bill_space_test",
    planId: "tiny",
    status: "active",
    currentPeriodStart: "2026-06-01T00:00:00.000Z",
    currentPeriodEnd: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putCreditBalance({
    spaceId: "space_test",
    availableCredits: 10,
    reservedCredits: 0,
    monthlyIncludedCredits: 1,
    purchasedCredits: 10,
    updatedAt: "2026-06-07T00:00:00.000Z",
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(runner.planJobs).toHaveLength(1);
  expect(planRun.status).toBe("blocked");
  expect(planRun.policy.reasons.join("\n")).toContain(
    "billing plan tiny quota resources count 2 exceeds 1 is exceeded",
  );
  const policyAudit = planRun.auditEvents.find(
    (event) => event.type === "plan.policy_evaluated" && event.data?.billing,
  );
  expect(policyAudit?.data?.billing).toMatchObject({
    mode: "enforce",
    planLimits: {
      planId: "tiny",
      subscriptionId: "sub_tiny",
      quota: { resources: 1 },
    },
  });
  expect(await store.getCreditReservationForRun(planRun.id)).toBeUndefined();
  expect(await store.getCreditBalance("space_test")).toMatchObject({
    availableCredits: 10,
    reservedCredits: 0,
  });
});

test("enforced billing reserves credits at plan and captures them at apply", async () => {
  const { store, controller } = await seededController();
  const space = await store.getSpace("space_test");
  await store.putSpace({
    ...space!,
    billingSettings: {
      mode: "enforce",
      provider: "manual",
      reservationRequired: true,
    },
  });
  await store.putCreditBalance({
    spaceId: "space_test",
    availableCredits: 10,
    reservedCredits: 0,
    monthlyIncludedCredits: 0,
    purchasedCredits: 10,
    updatedAt: "2026-06-07T00:00:00.000Z",
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toBe("succeeded");
  expect(await store.getCreditReservationForRun(planRun.id)).toMatchObject({
    status: "reserved",
    mode: "enforce",
    estimatedCredits: 1,
  });
  expect(await store.getCreditBalance("space_test")).toMatchObject({
    availableCredits: 9,
    reservedCredits: 1,
  });

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect((await store.getCreditReservationForRun(planRun.id))?.status).toBe(
    "captured",
  );
  expect(await store.getCreditBalance("space_test")).toMatchObject({
    availableCredits: 9,
    reservedCredits: 0,
  });
});

test("monthly included credits roll over from the active subscription period before billing reads and reservations", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedInstallationModel(store, { environment: "preview" });
  const now = Date.parse("2026-07-02T00:00:00.000Z");
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    vault: fakeProviderVault() as never,
    now: () => now,
    newId: deterministicIds(),
  });
  const space = await store.getSpace("space_test");
  await store.putSpace({
    ...space!,
    billingSettings: {
      mode: "enforce",
      provider: "manual",
      reservationRequired: true,
    },
  });
  await store.putBillingPlan({
    id: "pro",
    name: "Pro",
    monthlyBasePrice: 2000,
    includedCredits: 20,
    limits: {},
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  await store.putBillingAccount({
    id: "bill_space_test",
    ownerType: "space",
    ownerId: "space_test",
    provider: "manual",
    status: "active",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  await store.putSpaceSubscription({
    id: "sub_pro",
    spaceId: "space_test",
    billingAccountId: "bill_space_test",
    planId: "pro",
    status: "active",
    currentPeriodStart: "2026-07-01T00:00:00.000Z",
    currentPeriodEnd: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  await store.putCreditBalance({
    spaceId: "space_test",
    availableCredits: 12,
    reservedCredits: 0,
    monthlyIncludedCredits: 10,
    purchasedCredits: 4,
    updatedAt: "2026-06-15T00:00:00.000Z",
  });

  await expect(controller.getSpaceBilling("space_test")).resolves.toMatchObject(
    {
      billing: {
        balance: {
          availableCredits: 22,
          reservedCredits: 0,
          monthlyIncludedCredits: 20,
          purchasedCredits: 4,
        },
      },
    },
  );

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toBe("succeeded");
  expect(await store.getCreditBalance("space_test")).toMatchObject({
    availableCredits: 21,
    reservedCredits: 1,
    monthlyIncludedCredits: 20,
    purchasedCredits: 4,
  });
  expect(await store.getCreditReservationForRun(planRun.id)).toMatchObject({
    status: "reserved",
    mode: "enforce",
    estimatedCredits: 1,
  });
});

test("resource meter usage reconciliation is idempotent and rejects runner source", async () => {
  const { store, controller } = await seededController();

  const first = await controller.recordMeteredUsage("space_test", {
    installationId: "inst_fixture",
    kind: "managed_storage_gb_hour",
    quantity: 12.5,
    credits: 3,
    source: "resource_meter",
    idempotencyKey: "meter:inst_fixture:storage:2026-06-07T00",
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  const second = await controller.recordMeteredUsage("space_test", {
    installationId: "inst_fixture",
    kind: "managed_storage_gb_hour",
    quantity: 99,
    credits: 99,
    source: "resource_meter",
    idempotencyKey: "meter:inst_fixture:storage:2026-06-07T00",
    createdAt: "2026-06-07T00:30:00.000Z",
  });

  expect(second.usageEvent).toEqual(first.usageEvent);
  expect(await store.listUsageEvents("space_test")).toEqual([
    expect.objectContaining({
      installationId: "inst_fixture",
      kind: "managed_storage_gb_hour",
      quantity: 12.5,
      credits: 3,
      source: "resource_meter",
      idempotencyKey: "meter:inst_fixture:storage:2026-06-07T00",
    }),
  ]);
  await expect(
    controller.recordMeteredUsage("space_test", {
      kind: "runner_minute",
      quantity: 1,
      credits: 1,
      source: "runner" as never,
      idempotencyKey: "operator:bad-runner-source",
    }),
  ).rejects.toThrow("usage event source must be resource_meter");
});

test("managed resource recurring metering records period-scoped UsageEvents idempotently", async () => {
  const { store, controller } = await seededController();

  const input = {
    periodStart: "2026-06-07T00:00:00.000Z",
    periodEnd: "2026-06-07T01:00:00.000Z",
    meters: [
      {
        installationId: "inst_fixture",
        kind: "managed_compute" as const,
        quantity: 1,
        credits: 20,
        meterId: "cf-worker:inst_fixture",
      },
      {
        installationId: "inst_fixture",
        kind: "managed_storage_gb_hour" as const,
        quantity: 2.5,
        credits: 3,
        meterId: "r2:inst_fixture",
      },
    ],
  };

  const first = await controller.recordManagedResourceUsage(
    "space_test",
    input,
  );
  const second = await controller.recordManagedResourceUsage(
    "space_test",
    input,
  );

  expect(second.usageEvents).toEqual(first.usageEvents);
  expect(await store.listUsageEvents("space_test")).toEqual([
    expect.objectContaining({
      kind: "managed_compute",
      quantity: 1,
      credits: 20,
      source: "resource_meter",
      idempotencyKey:
        "managed-resource:space_test:2026-06-07T00:00:00.000Z:2026-06-07T01:00:00.000Z:cf-worker:inst_fixture:inst_fixture:managed_compute",
    }),
    expect.objectContaining({
      kind: "managed_storage_gb_hour",
      quantity: 2.5,
      credits: 3,
      source: "resource_meter",
      idempotencyKey:
        "managed-resource:space_test:2026-06-07T00:00:00.000Z:2026-06-07T01:00:00.000Z:r2:inst_fixture:inst_fixture:managed_storage_gb_hour",
    }),
  ]);
  await expect(
    controller.recordManagedResourceUsage("space_test", {
      periodStart: "2026-06-07T01:00:00.000Z",
      periodEnd: "2026-06-07T00:00:00.000Z",
      meters: [],
    }),
  ).rejects.toThrow("periodStart < periodEnd");
  await expect(
    controller.recordManagedResourceUsage("space_test", {
      periodStart: "2026-06-07T00:00:00.000Z",
      periodEnd: "2026-06-07T01:00:00.000Z",
      meters: [
        {
          kind: "runner_minute" as never,
          quantity: 1,
          credits: 1,
          meterId: "bad",
        },
      ],
    }),
  ).rejects.toThrow("managed resource usage kind is not supported");
});

test("invoice usage reconciliation records billing adjustment idempotently", async () => {
  const { store, controller } = await seededController();
  await store.putUsageEvent({
    id: "usage_runner",
    spaceId: "space_test",
    installationId: "inst_fixture",
    runId: "apply_fixture",
    kind: "runner_minute",
    quantity: 1.5,
    credits: 2,
    source: "runner",
    idempotencyKey: "apply_fixture:runner_minute",
    createdAt: "2026-06-07T00:10:00.000Z",
  });
  await controller.recordManagedResourceUsage("space_test", {
    periodStart: "2026-06-07T00:00:00.000Z",
    periodEnd: "2026-06-07T01:00:00.000Z",
    meters: [
      {
        installationId: "inst_fixture",
        kind: "managed_compute",
        quantity: 1,
        credits: 4,
        meterId: "cf-worker:inst_fixture",
      },
    ],
  });
  await controller.recordMeteredUsage("space_test", {
    kind: "operation",
    quantity: 1,
    credits: 99,
    source: "manual_adjustment",
    idempotencyKey: "manual:outside-invoice-meter",
    createdAt: "2026-06-07T00:20:00.000Z",
  });

  const first = await controller.reconcileInvoiceUsage("space_test", {
    invoiceId: "in_123",
    periodStart: "2026-06-07T00:00:00.000Z",
    periodEnd: "2026-06-07T01:00:00.000Z",
    invoicedCredits: 10,
  });
  const second = await controller.reconcileInvoiceUsage("space_test", {
    invoiceId: "in_123",
    periodStart: "2026-06-07T00:00:00.000Z",
    periodEnd: "2026-06-07T01:00:00.000Z",
    invoicedCredits: 10,
  });

  expect(second).toEqual(first);
  expect(first).toMatchObject({
    invoiceId: "in_123",
    meteredCredits: 6,
    invoicedCredits: 10,
    adjustmentCredits: 4,
    usageEvent: {
      kind: "operation",
      credits: 4,
      source: "billing_reconciliation",
      idempotencyKey:
        "invoice-reconciliation:space_test:in_123:2026-06-07T00:00:00.000Z:2026-06-07T01:00:00.000Z",
    },
  });
  expect(
    (await store.listUsageEvents("space_test")).filter(
      (event) => event.source === "billing_reconciliation",
    ),
  ).toHaveLength(1);
  await expect(
    controller.reconcileInvoiceUsage("space_test", {
      invoiceId: "in_bad",
      periodStart: "2026-06-07T01:00:00.000Z",
      periodEnd: "2026-06-07T00:00:00.000Z",
      invoicedCredits: 1,
    }),
  ).rejects.toThrow("periodStart < periodEnd");
});

test("Stripe subscription reconciliation updates billing ledger and Space settings", async () => {
  const { store, controller } = await seededController();

  const result = await controller.reconcileStripeSpaceSubscription(
    "space_test",
    {
      stripeCustomerId: "cus_space",
      stripeSubscriptionId: "sub_space",
      stripePriceId: "price_pro",
      planCode: "pro",
      status: "active",
      currentPeriodStartUnix: 1_780_000_000,
      currentPeriodEndUnix: 1_782_592_000,
    },
  );

  expect(result.billingAccount).toMatchObject({
    id: "bill_space_space_test",
    ownerType: "space",
    ownerId: "space_test",
    provider: "stripe",
    stripeCustomerId: "cus_space",
    status: "active",
  });
  expect(result.subscription).toMatchObject({
    id: "sub_space",
    spaceId: "space_test",
    billingAccountId: "bill_space_space_test",
    planId: "pro",
    status: "active",
  });
  expect(result.billing.settings).toEqual({
    mode: "enforce",
    provider: "stripe",
    reservationRequired: true,
  });
  expect(
    await store.getBillingAccountForOwner("space", "space_test"),
  ).toMatchObject({
    id: "bill_space_space_test",
    status: "active",
  });
  expect(await store.getSpaceSubscription("space_test")).toMatchObject({
    id: "sub_space",
    planId: "pro",
  });
  expect((await store.getSpace("space_test"))?.billingSettings).toEqual({
    mode: "enforce",
    provider: "stripe",
    reservationRequired: true,
  });

  const cancelled = await controller.reconcileStripeSpaceSubscription(
    "space_test",
    {
      stripeCustomerId: "cus_space",
      stripeSubscriptionId: "sub_space",
      planCode: "pro",
      status: "canceled",
    },
  );

  expect(cancelled.billingAccount.status).toBe("disabled");
  expect(cancelled.billing.settings).toEqual({
    mode: "disabled",
    provider: "none",
  });
  expect((await store.getSpace("space_test"))?.billingSettings).toEqual({
    mode: "disabled",
    provider: "none",
  });
});

test("installation plan returns a typed source_sync_required 409 when no snapshot exists", async () => {
  const { runner, controller } = await seededController({
    withoutSnapshot: true,
  });

  await expect(
    controller.createInstallationPlan("inst_fixture"),
  ).rejects.toMatchObject({ code: "failed_precondition" });
  await expect(
    controller.createInstallationPlan("inst_fixture"),
  ).rejects.toThrow(/source_sync_required/);
  expect(runner.planJobs).toHaveLength(0);
});

test("installation destroy-plan completes and the unified Run is waiting_approval", async () => {
  const { runner, controller } = await seededController();

  const { planRun } =
    await controller.createInstallationDestroyPlan("inst_fixture");
  expect(planRun.operation).toEqual("destroy");
  expect(planRun.status).toEqual("succeeded");

  // A destroy plan ALWAYS lands waiting_approval (spec §19 two-stage destroy),
  // independent of the environment's approval gate.
  const run = await controller.getRun(planRun.id);
  expect(run.type).toEqual("destroy_plan");
  expect(run.status).toEqual("waiting_approval");

  // The destroy plan dispatch still carries the installation state scope + archive.
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]!.stateScope?.generation).toEqual(0);
  expect(runner.planJobs[0]!.sourceArchive?.objectKey).toEqual(ARCHIVE_KEY);
});

test("installation apply emits generation base+1, records a StateSnapshot + Deployment, and bumps the generation", async () => {
  const { store, runner, controller } = await seededController();

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { applyRun, installation, deployment } =
    await controller.createApplyRun({
      planRunId: planRun.id,
      expected: applyExpectedGuardFromPlanRun(planRun),
    });
  expect(applyRun.status).toEqual("succeeded");

  // Apply persists state at base+1 (= 1).
  expect(runner.applyJobs).toHaveLength(1);
  const applyJob = runner.applyJobs[0]!;
  expect(applyJob.stateScope).toEqual({
    spaceId: "space_test",
    installationId: "inst_fixture",
    environment: "preview",
    generation: 1,
  });
  expect(applyJob.sourceArchive).toEqual({
    objectKey: ARCHIVE_KEY,
    digest: FIXTURE_ARCHIVE_DIGEST,
  });

  // The StateSnapshot is recorded at generation 1 with the runner's digest and
  // the spec §20 R2_STATE object key (installation-keyed).
  const latest = await store.getLatestStateSnapshot("inst_fixture", "preview");
  expect(latest?.generation).toEqual(1);
  expect(latest?.digest).toEqual(STATE_DIGEST);
  expect(latest?.installationId).toEqual("inst_fixture");
  expect(latest?.environment).toEqual("preview");
  expect(latest?.objectKey).toEqual(
    "spaces/space_test/installations/inst_fixture/envs/preview/states/00000001.tfstate.enc",
  );

  // §21 Deployment: the apply records an active Deployment with the new shape.
  expect(deployment?.status).toEqual("active");
  expect(deployment?.installationId).toEqual("inst_fixture");
  expect(deployment?.environment).toEqual("preview");
  expect(deployment?.applyRunId).toEqual(applyRun.id);
  expect(deployment?.sourceSnapshotId).toEqual("snap_fixture");
  expect(deployment?.stateGeneration).toEqual(1);
  expect(deployment?.outputsPublic).toMatchObject({
    launch_url: "https://x.example",
  });
  expect(await store.getPlanRunInputs(planRun.id)).toBeUndefined();

  // The Installation is marked active with a bumped generation + current deployment.
  expect(installation?.status).toEqual("active");
  expect(installation?.currentStateGeneration).toEqual(1);
  expect(installation?.currentDeploymentId).toEqual(deployment?.id);
});

test("installation apply records an OutputSnapshot and links it on the Deployment + Installation", async () => {
  const { store, controller } = await seededController();

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { installation, deployment } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  // The OutputSnapshot is recorded and linked from both the Deployment and the
  // Installation's currentOutputSnapshotId.
  expect(deployment?.outputSnapshotId).toBeDefined();
  expect(installation?.currentOutputSnapshotId).toEqual(
    deployment?.outputSnapshotId,
  );

  const snapshot = await store.getOutputSnapshot(deployment!.outputSnapshotId!);
  expect(snapshot).toBeDefined();
  expect(snapshot?.installationId).toEqual("inst_fixture");
  expect(snapshot?.stateGeneration).toEqual(1);
  // rawOutputArtifactKey is the §26 key the runner DO echoed (rawOutputsKey).
  expect(snapshot?.rawOutputArtifactKey).toEqual(
    "spaces/space_test/installations/inst_fixture/runs/apply_0007/outputs.raw.json.enc",
  );

  // spaceOutputs = InstallConfig.outputAllowlist projection after sensitive
  // filtering and type validation.
  expect(snapshot?.spaceOutputs).toEqual({
    launch_url: "https://x.example",
  });
  // publicOutputs = InstallConfig.outputAllowlist projection (what
  // Deployment.outputsPublic carries).
  expect(snapshot?.publicOutputs).toEqual({ launch_url: "https://x.example" });
  expect(snapshot?.publicOutputs).toEqual(
    deployment?.outputsPublic as Record<string, unknown>,
  );

  // The digest is stable + recomputable over { spaceOutputs, publicOutputs }.
  const { stableJsonDigest } = await import("../../adapters/source/digest.ts");
  expect(snapshot?.outputDigest).toEqual(
    await stableJsonDigest({
      spaceOutputs: snapshot!.spaceOutputs,
      publicOutputs: snapshot!.publicOutputs,
    }),
  );

  // getLatestOutputSnapshot resolves the same record.
  const latest = await store.getLatestOutputSnapshot("inst_fixture");
  expect(latest?.id).toEqual(snapshot?.id);
});

test("generic Capsule apply projects InstallConfig outputAllowlist outputs", async () => {
  const { store, controller } = await seededController({
    installConfig: {
      outputAllowlist: {
        endpoint: { from: "public_url", type: "url", required: true },
      },
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { deployment } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(deployment?.outputsPublic).toEqual({
    endpoint: "https://public.example",
  });
  const snapshot = await store.getOutputSnapshot(deployment!.outputSnapshotId!);
  expect(snapshot?.publicOutputs).toEqual({
    endpoint: "https://public.example",
  });
  expect(snapshot?.spaceOutputs).toEqual({
    endpoint: "https://public.example",
  });
  expect(snapshot?.publicOutputs).not.toHaveProperty("admin_token");
});

test("OutputSnapshot projection fails closed on required output type mismatch", async () => {
  const { controller } = await seededController({
    installConfig: {
      outputAllowlist: {
        bucket_name: { from: "bucket_name", type: "url", required: true },
      },
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { applyRun, deployment } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(deployment).toBeUndefined();
  expect(applyRun.status).toEqual("failed");
  expect(JSON.stringify(applyRun.diagnostics)).toContain(
    "does not match declared projection type url",
  );
});

test("a sensitive-flagged runner output leaks into NO projection (invariants 11/12)", async () => {
  const { store, controller } = await seededController();

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { applyRun, deployment } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  const snapshot = await store.getOutputSnapshot(deployment!.outputSnapshotId!);

  // The sensitive value never appears anywhere in the public projections.
  const serializedSnapshot = JSON.stringify(snapshot);
  expect(serializedSnapshot).not.toContain("admin_token");
  expect(serializedSnapshot).not.toContain("super-secret-token");
  expect(snapshot?.spaceOutputs).not.toHaveProperty("admin_token");
  expect(snapshot?.publicOutputs).not.toHaveProperty("admin_token");

  // Nor on the public Deployment projection.
  const serializedDeployment = JSON.stringify(deployment);
  expect(serializedDeployment).not.toContain("admin_token");
  expect(serializedDeployment).not.toContain("super-secret-token");
  expect(deployment?.outputsPublic).not.toHaveProperty("admin_token");

  // Nor on the public §19 Run projection of the apply run, nor the ApplyRun's
  // own public outputs (the well-known projection drops it).
  const run = await controller.getRun(applyRun.id);
  expect(JSON.stringify(run)).not.toContain("admin_token");
  expect(JSON.stringify(run)).not.toContain("super-secret-token");
  const reread = await controller.getApplyRun(applyRun.id);
  expect(JSON.stringify(reread.applyRun.outputs ?? [])).not.toContain(
    "admin_token",
  );
  expect(JSON.stringify(reread.applyRun.outputs ?? [])).not.toContain(
    "super-secret-token",
  );
});

test("a second installation plan reads the bumped generation and its apply moves to gen 2", async () => {
  const { store, runner, controller } = await seededController();

  const first = await controller.createInstallationPlan("inst_fixture");
  await controller.createApplyRun({
    planRunId: first.planRun.id,
    expected: applyExpectedGuardFromPlanRun(first.planRun),
  });

  // Second plan sees the installation at generation 1 now.
  const second = await controller.createInstallationPlan("inst_fixture");
  expect(second.planRun.baseStateGeneration).toEqual(1);
  expect(runner.planJobs[1]!.stateScope?.generation).toEqual(1);

  await controller.createApplyRun({
    planRunId: second.planRun.id,
    expected: applyExpectedGuardFromPlanRun(second.planRun),
  });
  expect(runner.applyJobs[1]!.stateScope?.generation).toEqual(2);
  const latest = await store.getLatestStateSnapshot("inst_fixture", "preview");
  expect(latest?.generation).toEqual(2);
});

test("apply is rejected when the plan's SourceSnapshot is no longer present", async () => {
  const { store, controller } = await seededController();

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const tampered: PlanRun = {
    ...(await store.getPlanRun(planRun.id))!,
    sourceSnapshotId: "snap_missing",
  };
  await store.putPlanRun(tampered);

  await expect(
    controller.createApplyRun({
      planRunId: planRun.id,
      expected: applyExpectedGuardFromPlanRun(planRun),
    }),
  ).rejects.toThrow(/source_snapshot/);
});

test("installation apply is rejected when the state generation advanced since plan", async () => {
  const { store, controller } = await seededController();

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  // Simulate a sibling apply advancing the installation state generation to 1.
  await store.putStateSnapshot({
    id: "state_sibling",
    spaceId: "space_test",
    installationId: "inst_fixture",
    environment: "preview",
    generation: 1,
    objectKey:
      "spaces/space_test/installations/inst_fixture/envs/preview/states/00000001.tfstate.enc",
    digest: STATE_DIGEST,
    createdByRunId: "apply_sibling",
    createdAt: "2026-06-06T00:09:59.000Z",
  });

  const staleApply = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(staleApply.applyRun.status).toBe("failed");
  expect(staleApply.applyRun.diagnostics?.[0]?.message).toContain(
    "state_generation_mismatch",
  );
});

test("installation destroy-plan apply tears down state at base+1 after approval and marks the installation destroyed", async () => {
  const { store, runner, controller } = await seededController();

  // Establish a generation-1 state via a create apply first.
  const create = await controller.createInstallationPlan("inst_fixture");
  const created = await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });
  const createdDeploymentId = created.deployment?.id;

  // Destroy-plan lands waiting_approval; approve, then apply.
  const destroy =
    await controller.createInstallationDestroyPlan("inst_fixture");
  expect(destroy.planRun.baseStateGeneration).toEqual(1);
  const waiting = await controller.getRun(destroy.planRun.id);
  expect(waiting.status).toEqual("waiting_approval");
  await controller.approveRun(destroy.planRun.id);

  const { applyRun, installation } = await controller.createApplyRun({
    planRunId: destroy.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroy.planRun),
  });
  expect(applyRun.status).toEqual("succeeded");

  expect(runner.destroyJobs).toHaveLength(1);
  // Teardown persists at base+1 (= 2).
  expect(runner.destroyJobs[0]!.stateScope?.generation).toEqual(2);
  const destroyProviderEvent = applyRun.auditEvents.find(
    (event) => event.type === "destroy.provider_installation_evaluated",
  );
  expect(destroyProviderEvent?.data).toMatchObject({
    requireMirror: true,
    evidenceCount: 1,
    mirroredCount: 1,
    attestedCount: 1,
  });
  const latest = await store.getLatestStateSnapshot("inst_fixture", "preview");
  expect(latest?.generation).toEqual(2);

  // The Installation is marked destroyed with the current deployment cleared.
  expect(installation?.status).toEqual("destroyed");
  expect(installation?.currentDeploymentId).toBeUndefined();
  expect(installation?.currentStateGeneration).toEqual(2);

  // The previously-active Deployment is marked destroyed (§21 status transition).
  if (createdDeploymentId) {
    const previous = await store.getDeployment(createdDeploymentId);
    expect(previous?.status).toEqual("destroyed");
  }
});

test("the previous active Deployment is superseded on a second successful apply", async () => {
  const { store, controller } = await seededController();

  const first = await controller.createInstallationPlan("inst_fixture");
  const firstApply = await controller.createApplyRun({
    planRunId: first.planRun.id,
    expected: applyExpectedGuardFromPlanRun(first.planRun),
  });
  const firstDeploymentId = firstApply.deployment!.id;

  const second = await controller.createInstallationPlan("inst_fixture");
  const secondApply = await controller.createApplyRun({
    planRunId: second.planRun.id,
    expected: applyExpectedGuardFromPlanRun(second.planRun),
  });

  const previous = await store.getDeployment(firstDeploymentId);
  expect(previous?.status).toEqual("superseded");
  expect(secondApply.deployment?.status).toEqual("active");
  expect(secondApply.deployment?.stateGeneration).toEqual(2);
});

test("OpenTofuControllerError is surfaced for an unknown installation", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const controller = controllerWith(store, recordingRunner());
  await expect(
    controller.createInstallationPlan("inst_missing"),
  ).rejects.toBeInstanceOf(OpenTofuControllerError);
});
