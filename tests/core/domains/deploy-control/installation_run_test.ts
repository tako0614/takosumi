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
  OpenTofuDeploymentControllerDependencies,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRunner,
  ReleaseActivationInput,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  OpenTofuControllerError,
  OpenTofuDeploymentController,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import type { OpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import { MemoryObjectStorage } from "../../../../core/adapters/object-storage/mod.ts";
import {
  CredentialBundle,
  PhaseMintBundle,
} from "../../../../core/adapters/vault/mod.ts";
import { ActivityService } from "../../../../core/domains/activity/mod.ts";
import { InMemoryObservabilitySink } from "../../../../core/domains/observability/mod.ts";
import type {
  Connection,
  Deployment,
  OpenTofuOutputEnvelope,
  PlanRun,
  PlanResourceChange,
  RunnerProfile,
} from "@takosumi/internal/deploy-control-api";
import type {
  BillingCaptureContext,
  BillingEnforcement,
  BillingReleaseContext,
  BillingReservationContext,
} from "takosumi-contract/billing";
import {
  runnerMinuteUsdMicros,
  usdMicrosToLegacyCredits,
} from "takosumi-contract/billing";
import {
  FIXTURE_ARCHIVE_DIGEST,
  seedInstallationModel,
  seedProviderConnections,
  type SeedModelOptions,
} from "../../../helpers/deploy-control/model_fixture.ts";

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
  applyOutputs?: OpenTofuOutputEnvelope,
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
        outputs: applyOutputs ?? {
          launch_url: { sensitive: false, value: "https://x.example" },
          public_url: { sensitive: false, value: "https://public.example" },
          public_status: { sensitive: false, value: "sk-output-raw-token" },
          bucket_name: { sensitive: false, value: "my-bucket" },
          admin_token: { sensitive: true, value: "super-secret-token" },
        },
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
  overrides: Partial<OpenTofuDeploymentControllerDependencies> = {},
): OpenTofuDeploymentController {
  return new OpenTofuDeploymentController({
    store,
    runner,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
    ...overrides,
  });
}

class HangingRunnerProfileSeedStore extends InMemoryOpenTofuDeploymentStore {
  override putRunnerProfile(profile: RunnerProfile): Promise<RunnerProfile> {
    void profile;
    return new Promise(() => {
      // Intentionally pending: plan/apply hot paths use the controller's
      // configured runner profile snapshot instead of waiting for seed writes.
    });
  }
}

async function expectWithin<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function multiProviderRunnerProfile(
  providers: readonly string[] = [
    "registry.opentofu.org/cloudflare/cloudflare",
    "registry.opentofu.org/hashicorp/aws",
  ],
): RunnerProfile {
  return {
    id: "multi-provider-mirror-test",
    name: "Multi-provider mirror test",
    substrate: "cloudflare-containers",
    allowedProviders: providers,
    credentialRefs: providers.map((provider) => ({
      provider,
      ref: "secret://takosumi/multi-provider-mirror-test",
      required: true,
    })),
    requireCredentialRefs: true,
    stateBackend: { kind: "operator-managed", ref: "r2://state" },
    stateLock: { kind: "native" },
    networkPolicy: { mode: "operator-managed" },
    secretExposure: {
      providerCredentials: "runner-only",
      tenantWorkerOperatorSecrets: "forbidden",
      redactLogs: true,
      blockSensitiveOutputs: true,
    },
  };
}

function activityRecorderFor(store: OpenTofuDeploymentStore): ActivityService {
  let nextId = 1;
  let nextMs = Date.parse("2026-06-07T00:00:00.000Z");
  return new ActivityService({
    store,
    newId: (prefix) => `${prefix}_test_${String(nextId++).padStart(4, "0")}`,
    now: () => new Date(nextMs++),
  });
}

function fakeProviderVault() {
  const evidenceForEntry = (entry: {
    readonly provider: string;
    readonly connectionId: string;
    readonly delivery?: "provider_env" | "generated_root_variable";
  }) => ({
    provider: canonicalProviderForFixture(entry.provider),
    connectionId: entry.connectionId,
    delivery: entry.delivery ?? ("generated_root_variable" as const),
    rootOnly:
      (entry.delivery ?? "generated_root_variable") ===
      "generated_root_variable",
    temporary: true,
    ttlEnforced: true,
    phase: "plan" as const,
  });
  const envForEntry = (entry: {
    readonly provider: string;
    readonly connectionId: string;
    readonly delivery?: "provider_env" | "generated_root_variable";
  }) => {
    const shortName = providerShortNameForFixture(entry.provider);
    if (entry.delivery === "provider_env") {
      if (shortName === "aws") {
        return {
          AWS_ACCESS_KEY_ID: "fixture-provider-token",
          AWS_SECRET_ACCESS_KEY: "fixture-provider-token",
          AWS_SESSION_TOKEN: "fixture-provider-token",
        };
      }
      if (shortName === "cloudflare") {
        return { CLOUDFLARE_API_TOKEN: "fixture-provider-token" };
      }
      return { [`${shortName.toUpperCase()}_TOKEN`]: "fixture-provider-token" };
    }
    if (shortName === "aws") {
      return {
        TF_VAR_aws_main_access_key_id: "fixture-provider-token",
        TF_VAR_aws_main_secret_access_key: "fixture-provider-token",
        TF_VAR_aws_main_session_token: "fixture-provider-token",
      };
    }
    if (shortName === "cloudflare") {
      return { TF_VAR_cloudflare_main_api_token: "fixture-provider-token" };
    }
    return { [`TF_VAR_${shortName}_main_token`]: "fixture-provider-token" };
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
    mintForInstallationProviderEnvBindings: (
      _spaceId: string,
      entries: readonly { provider: string; connectionId: string }[] = [],
      options?: {
        readonly delivery?: "provider_env" | "generated_root_variable";
      },
    ) => {
      const resolvedEntries =
        entries.length > 0
          ? entries
          : [{ provider: "cloudflare", connectionId: "fixture" }];
      const entriesWithDelivery = resolvedEntries.map((entry) => ({
        ...entry,
        delivery: options?.delivery ?? ("generated_root_variable" as const),
      }));
      const env = Object.assign({}, ...entriesWithDelivery.map(envForEntry));
      const evidence = entriesWithDelivery.map(evidenceForEntry);
      return Promise.resolve(new PhaseMintBundle({ env }, [], evidence));
    },
  };
}

function canonicalProviderForFixture(provider: string): string {
  if (provider === "aws" || provider.includes("hashicorp/aws")) {
    return "registry.opentofu.org/hashicorp/aws";
  }
  if (provider === "cloudflare" || provider.includes("cloudflare/cloudflare")) {
    return "registry.opentofu.org/cloudflare/cloudflare";
  }
  return provider;
}

function providerShortNameForFixture(provider: string): string {
  if (provider === "aws" || provider.includes("hashicorp/aws")) return "aws";
  if (provider === "cloudflare" || provider.includes("cloudflare/cloudflare")) {
    return "cloudflare";
  }
  return (
    provider
      .split("/")
      .pop()
      ?.replace(/[^A-Za-z0-9_]/g, "_") ?? provider
  );
}

async function putConnectionWithProviderEnv(
  store: OpenTofuDeploymentStore,
  conn: Connection,
): Promise<void> {
  if (!conn.spaceId) {
    throw new Error(
      "putConnectionWithProviderEnv only seeds Space-scoped secret Provider Connections; global operator credentials must not become bindable Provider Connections",
    );
  }
  // After the credential-model collapse the connection IS the resolver record,
  // so enrich it with the required providerSource/materialization fields and
  // store the single unified row (no separate ProviderEnv).
  const connection: Connection = {
    ...conn,
    providerSource:
      conn.providerSource ?? canonicalProviderForFixture(conn.provider),
    materialization: conn.materialization ?? "secret",
    envNames: conn.envNames ?? [],
  };
  await store.putConnection(connection);
}

function cloudflareConnection(id: string, spaceId = "space_test"): Connection {
  return {
    id,
    spaceId,
    scope: "space",
    provider: "cloudflare",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    kind: "cloudflare_api_token",
    materialization: "secret",
    status: "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
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
    mintForInstallationProviderEnvBindings: () => {
      mintCount += 1;
      return Promise.resolve(
        new PhaseMintBundle(
          {
            env: {
              TF_VAR_cloudflare_main_api_token: "fixture-provider-token",
            },
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
  await seedRunnableInstallationModel(store, {
    environment: "preview",
    ...options,
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });
  return { store, runner, controller };
}

async function seedRunnableInstallationModel(
  store: OpenTofuDeploymentStore,
  options: SeedModelOptions = {},
) {
  const seeded = await seedInstallationModel(store, options);
  await seedProviderConnections(store, seeded.installation);
  return seeded;
}

test("installation plan dispatch carries sourceArchive + stateScope at the current generation", async () => {
  const { runner, controller } = await seededController();

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.sourceSnapshotId).toEqual("snap_fixture");
  expect(planRun.installationContext).toEqual({
    workspaceId: "space_test",
    spaceId: "space_test",
    capsuleId: "inst_fixture",
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
    workspaceId: "space_test",
    capsuleId: "inst_fixture",
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

test("installation plan does not wait for runner profile seed persistence", async () => {
  const store = new HangingRunnerProfileSeedStore();
  const runner = recordingRunner();
  await seedRunnableInstallationModel(store);
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await expectWithin(
    controller.createInstallationPlan("inst_fixture"),
    1_000,
  );

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.runnerProfileId).toEqual(profile.id);
  expect(runner.planJobs).toHaveLength(1);
});

test("installation plan does not invent Cloudflare Capsule inputs from scope hints", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      variableMapping: { project_name: "takos" },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_scope",
      seeded.installation.spaceId,
    ),
    scopeHints: { accountId: "acct_scope_123" },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_scope",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_scope",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createInstallationPlan(
    seeded.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain('project_name = "takos"');
  expect(mainTf).not.toContain("cloudflare = jsondecode");
  expect(mainTf).not.toContain("acct_scope_123");
  expect(mainTf).not.toContain("fixture-provider-token");
  expect(JSON.stringify(await store.getPlanRun(planRun.id))).not.toContain(
    "fixture-provider-token",
  );
});

test("requested Cloudflare Capsule input can be filled from provider scope hints", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      variableMapping: { project_name: "takos", cloudflare: {} },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_scope",
      seeded.installation.spaceId,
    ),
    scopeHints: { accountId: "acct_scope_123" },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_scope",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_scope",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createInstallationPlan(
    seeded.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain('project_name = "takos"');
  expect(mainTf).toContain(
    'cloudflare = jsondecode("{\\"account_id\\":\\"acct_scope_123\\"}")',
  );
  expect(mainTf).not.toContain("fixture-provider-token");
});

test("dotted Cloudflare Capsule input merges with provider scope hints", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      variableMapping: {
        "cloudflare.workers_subdomain": "shoutatomiyama0614",
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_scope",
      seeded.installation.spaceId,
    ),
    scopeHints: { accountId: "acct_scope_123" },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_scope",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_scope",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createInstallationPlan(
    seeded.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain('\\"account_id\\":\\"acct_scope_123\\"');
  expect(mainTf).toContain('\\"workers_subdomain\\":\\"shoutatomiyama0614\\"');
  expect(mainTf).not.toContain("cloudflare.workers_subdomain");
  expect(mainTf).not.toContain("fixture-provider-token");
});

test("requested scalar Cloudflare Capsule inputs can be filled from provider scope hints", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      variableMapping: {
        cloudflare_account_id: null,
        account_id: null,
        cloudflare_api_base_url: null,
        cloudflare_workers_subdomain: null,
        workersSubdomain: null,
        cloudflare: {
          api_base_url: null,
          workers_subdomain: null,
        },
        untouched: null,
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_scope",
      seeded.installation.spaceId,
    ),
    scopeHints: {
      managedProvider: true,
      providerBaseUrl: "https://app.takosumi.com/compat/cloudflare/client/v4",
      accountId: "acct_scope_123",
      workersSubdomain: "team-workers",
    },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_scope",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_scope",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createInstallationPlan(
    seeded.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain('cloudflare_account_id = "acct_scope_123"');
  expect(mainTf).toContain('account_id = "acct_scope_123"');
  expect(mainTf).toContain(
    'cloudflare_api_base_url = "https://app.takosumi.com/compat/cloudflare/client/v4"',
  );
  expect(mainTf).toContain('cloudflare_workers_subdomain = "team-workers"');
  expect(mainTf).toContain('workersSubdomain = "team-workers"');
  expect(mainTf).toContain(
    'cloudflare = jsondecode("{\\"account_id\\":\\"acct_scope_123\\",\\"api_base_url\\":\\"https://app.takosumi.com/compat/cloudflare/client/v4\\",\\"workers_subdomain\\":\\"team-workers\\"}")',
  );
  expect(mainTf).toContain("untouched = null");
  expect(mainTf).not.toContain("fixture-provider-token");
});

test("managed Cloudflare Capsule inputs derive app.takos.jp launch defaults server-side", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, {
    name: "Yuru Managed App",
    environment: "preview",
    installConfig: {
      variableMapping: {
        cloudflare_route_zone_id: null,
        cloudflare_route_pattern: null,
        cloudflare: {
          account_id: null,
          api_base_url: null,
        },
      },
      catalog: {
        order: 100,
        surface: "service",
        kind: "worker",
        provider: "cloudflare",
        suggestedName: "yurucommu",
        badge: { ja: "追加候補", en: "Installable" },
        name: { ja: "yurucommu", en: "yurucommu" },
        description: { ja: "テスト", en: "Test" },
        inputs: [],
        installExperience: {
          publicEndpoint: {
            subdomainVariable: "worker_name",
            urlVariable: "app_url",
            routePatternVariable: "cloudflare_route_pattern",
            baseDomain: "app.takos.jp",
          },
        },
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_scope",
      seeded.installation.spaceId,
    ),
    scopeHints: {
      managedProvider: true,
      providerBaseUrl: "https://app.takosumi.com/compat/cloudflare/client/v4",
      accountId: "ts_acc_takosumi_cloud",
      zoneId: "zone_takosumi_cloud",
    },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_scope",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_scope",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createInstallationPlan(
    seeded.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain('worker_name = "yuru-managed-app-fixture"');
  expect(mainTf).toContain(
    'app_url = "https://yuru-managed-app-fixture.app.takos.jp"',
  );
  expect(mainTf).toContain('cloudflare_route_zone_id = "zone_takosumi_cloud"');
  expect(mainTf).toContain(
    'cloudflare_route_pattern = "yuru-managed-app-fixture.app.takos.jp/*"',
  );
  expect(mainTf).toContain(
    'cloudflare = jsondecode("{\\"account_id\\":\\"ts_acc_takosumi_cloud\\",\\"api_base_url\\":\\"https://app.takosumi.com/compat/cloudflare/client/v4\\"}")',
  );
  expect(mainTf).not.toContain("fixture-provider-token");
});

test("managed Cloudflare Capsule explicit worker_name drives app.takos.jp URL defaults", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, {
    name: "Yuru Managed App",
    environment: "preview",
    installConfig: {
      variableMapping: {
        worker_name: "custom-yuru",
        app_url: null,
        cloudflare_route_zone_id: null,
        cloudflare_route_pattern: null,
        cloudflare: {
          account_id: null,
          api_base_url: null,
        },
      },
      catalog: {
        order: 100,
        surface: "service",
        kind: "worker",
        provider: "cloudflare",
        suggestedName: "yurucommu",
        badge: { ja: "追加候補", en: "Installable" },
        name: { ja: "yurucommu", en: "yurucommu" },
        description: { ja: "テスト", en: "Test" },
        inputs: [],
        installExperience: {
          publicEndpoint: {
            subdomainVariable: "worker_name",
            urlVariable: "app_url",
            routePatternVariable: "cloudflare_route_pattern",
            baseDomain: "app.takos.jp",
          },
        },
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_scope",
      seeded.installation.spaceId,
    ),
    scopeHints: {
      managedProvider: true,
      providerBaseUrl: "https://app.takosumi.com/compat/cloudflare/client/v4",
      accountId: "ts_acc_takosumi_cloud",
      zoneId: "zone_takosumi_cloud",
    },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_scope",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_scope",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createInstallationPlan(
    seeded.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain('worker_name = "custom-yuru"');
  expect(mainTf).toContain('app_url = "https://custom-yuru.app.takos.jp"');
  expect(mainTf).toContain(
    'cloudflare_route_pattern = "custom-yuru.app.takos.jp/*"',
  );
});

test("managed Cloudflare Capsule honors operator managed public base domain", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, {
    name: "Yuru Managed App",
    environment: "preview",
    installConfig: {
      variableMapping: {
        worker_name: "custom-yuru",
        app_url: null,
        cloudflare_route_zone_id: null,
        cloudflare_route_pattern: null,
        cloudflare: {
          account_id: null,
          api_base_url: null,
        },
      },
      catalog: {
        order: 100,
        surface: "service",
        kind: "worker",
        provider: "cloudflare",
        suggestedName: "yurucommu",
        badge: { ja: "追加候補", en: "Installable" },
        name: { ja: "yurucommu", en: "yurucommu" },
        description: { ja: "テスト", en: "Test" },
        inputs: [],
        installExperience: {
          publicEndpoint: {
            subdomainVariable: "worker_name",
            urlVariable: "app_url",
            routePatternVariable: "cloudflare_route_pattern",
            baseDomain: "apps.example.org",
          },
        },
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_scope",
      seeded.installation.spaceId,
    ),
    scopeHints: {
      managedProvider: true,
      providerBaseUrl:
        "https://operator.example.org/compat/cloudflare/client/v4",
      accountId: "ts_acc_operator",
      zoneId: "zone_operator_apps",
    },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_scope",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_scope",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createInstallationPlan(
    seeded.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain('worker_name = "custom-yuru"');
  expect(mainTf).toContain('app_url = "https://custom-yuru.apps.example.org"');
  expect(mainTf).toContain(
    'cloudflare_route_pattern = "custom-yuru.apps.example.org/*"',
  );
  expect(mainTf).toContain('cloudflare_route_zone_id = "zone_operator_apps"');
});

test("managed Cloudflare Capsule rejects unverified custom public app_url", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, {
    name: "Yuru Managed App",
    environment: "preview",
    installConfig: {
      variableMapping: {
        app_url: "https://community.example.com",
        cloudflare: {
          account_id: null,
          api_base_url: null,
        },
      },
      catalog: {
        order: 100,
        surface: "service",
        kind: "worker",
        provider: "cloudflare",
        suggestedName: "yurucommu",
        badge: { ja: "追加候補", en: "Installable" },
        name: { ja: "yurucommu", en: "yurucommu" },
        description: { ja: "テスト", en: "Test" },
        inputs: [],
        installExperience: {
          publicEndpoint: {
            subdomainVariable: "worker_name",
            urlVariable: "app_url",
            routePatternVariable: "cloudflare_route_pattern",
            baseDomain: "apps.example.org",
          },
        },
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_scope",
      seeded.installation.spaceId,
    ),
    scopeHints: {
      managedProvider: true,
      providerBaseUrl: "https://app.takosumi.com/compat/cloudflare/client/v4",
      accountId: "ts_acc_takosumi_cloud",
    },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_scope",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_scope",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  await expect(
    controller.createInstallationPlan(seeded.installation.id),
  ).rejects.toThrow(
    "custom_domain_verification_required: custom domains must be verified before managed deploy",
  );
});

test("managed Cloudflare Capsule allows managed-base app_url and route pattern without custom-domain quota", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, {
    name: "Managed Public Host App",
    environment: "preview",
    installConfig: {
      variableMapping: {
        app_url: "https://community.apps.example.org",
        cloudflare_route_pattern: "community.apps.example.org/*",
        cloudflare: {
          account_id: null,
          api_base_url: null,
        },
      },
      catalog: {
        order: 100,
        surface: "service",
        kind: "worker",
        provider: "cloudflare",
        suggestedName: "managed-public-host",
        badge: { ja: "追加候補", en: "Installable" },
        name: { ja: "managed", en: "managed" },
        description: { ja: "テスト", en: "Test" },
        inputs: [],
        installExperience: {
          publicEndpoint: {
            subdomainVariable: "worker_name",
            urlVariable: "app_url",
            routePatternVariable: "cloudflare_route_pattern",
            baseDomain: "apps.example.org",
          },
        },
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_managed_host",
      seeded.installation.spaceId,
    ),
    scopeHints: {
      managedProvider: true,
      providerBaseUrl: "https://app.takosumi.com/compat/cloudflare/client/v4",
      accountId: "ts_acc_takosumi_cloud",
    },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_managed_host",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_managed_host",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createInstallationPlan(
    seeded.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
  await expect(
    store.getPublicHostReservation("community.apps.example.org"),
  ).resolves.toMatchObject({
    hostname: "community.apps.example.org",
    installationId: seeded.installation.id,
    status: "reserved",
  });
});

test("managed Cloudflare app.takos.jp host is globally claimed across Workspaces", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const first = await seedInstallationModel(store, {
    spaceId: "space_first",
    sourceId: "src_first",
    snapshotId: "snap_first",
    installConfigId: "cfg_first",
    installationId: "inst_first",
    name: "Shared App",
    environment: "preview",
    installConfig: {
      variableMapping: {
        worker_name: "shared-app",
        app_url: null,
        cloudflare: {
          account_id: null,
          api_base_url: null,
        },
      },
      catalog: {
        order: 100,
        surface: "service",
        kind: "worker",
        provider: "cloudflare",
        suggestedName: "shared-app",
        badge: { ja: "追加候補", en: "Installable" },
        name: { ja: "Shared App", en: "Shared App" },
        description: { ja: "テスト", en: "Test" },
        inputs: [],
        installExperience: {
          publicEndpoint: {
            subdomainVariable: "worker_name",
            urlVariable: "app_url",
            baseDomain: "app.takos.jp",
          },
        },
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_first",
      first.installation.spaceId,
    ),
    scopeHints: {
      managedProvider: true,
      providerBaseUrl: "https://app.takosumi.com/compat/cloudflare/client/v4",
      accountId: "ts_acc_takosumi_cloud",
    },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_first",
    spaceId: first.installation.spaceId,
    installationId: first.installation.id,
    environment: first.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_first",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  await controller.createInstallationPlan(first.installation.id);
  await store.putInstallation({
    ...first.installation,
    status: "active",
    currentStateGeneration: 1,
  });

  const second = await seedInstallationModel(store, {
    spaceId: "space_second",
    sourceId: "src_second",
    snapshotId: "snap_second",
    installConfigId: "cfg_second",
    installationId: "inst_second",
    name: "Shared App",
    environment: "preview",
    installConfig: {
      variableMapping: {
        worker_name: "shared-app",
        app_url: null,
        cloudflare: {
          account_id: null,
          api_base_url: null,
        },
      },
      catalog: {
        order: 100,
        surface: "service",
        kind: "worker",
        provider: "cloudflare",
        suggestedName: "shared-app",
        badge: { ja: "追加候補", en: "Installable" },
        name: { ja: "Shared App", en: "Shared App" },
        description: { ja: "テスト", en: "Test" },
        inputs: [],
        installExperience: {
          publicEndpoint: {
            subdomainVariable: "worker_name",
            urlVariable: "app_url",
            baseDomain: "app.takos.jp",
          },
        },
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_second",
      second.installation.spaceId,
    ),
    scopeHints: {
      managedProvider: true,
      providerBaseUrl: "https://app.takosumi.com/compat/cloudflare/client/v4",
      accountId: "ts_acc_takosumi_cloud",
    },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_second",
    spaceId: second.installation.spaceId,
    installationId: second.installation.id,
    environment: second.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_second",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });

  await expect(
    controller.createInstallationPlan(second.installation.id),
  ).rejects.toThrow("app_hostname_unavailable: already exists");
});

test("managed Cloudflare app.takos.jp host claim prefers active Capsule over stale historical output", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const stale = await seedInstallationModel(store, {
    spaceId: "space_stale",
    sourceId: "src_stale",
    snapshotId: "snap_stale",
    installConfigId: "cfg_stale",
    installationId: "inst_stale",
    name: "Shared App Stale",
    environment: "preview",
  });
  await store.putOutputSnapshot({
    id: "out_stale",
    workspaceId: stale.installation.spaceId,
    spaceId: stale.installation.spaceId,
    capsuleId: stale.installation.id,
    installationId: stale.installation.id,
    stateGeneration: 1,
    rawOutputArtifactKey: "outputs/stale.json.enc",
    publicOutputs: { url: "https://shared-app.app.takos.jp" },
    workspaceOutputs: { url: "https://shared-app.app.takos.jp" },
    spaceOutputs: { url: "https://shared-app.app.takos.jp" },
    outputDigest: "sha256:stale",
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putInstallation({
    ...stale.installation,
    status: "stale",
    currentStateGeneration: 1,
    currentOutputSnapshotId: "out_stale",
  });

  const active = await seedInstallationModel(store, {
    spaceId: "space_active",
    sourceId: "src_active",
    snapshotId: "snap_active",
    installConfigId: "cfg_active",
    installationId: "inst_active",
    name: "Shared App Active",
    environment: "preview",
  });
  await store.putOutputSnapshot({
    id: "out_active",
    workspaceId: active.installation.spaceId,
    spaceId: active.installation.spaceId,
    capsuleId: active.installation.id,
    installationId: active.installation.id,
    stateGeneration: 1,
    rawOutputArtifactKey: "outputs/active.json.enc",
    publicOutputs: { url: "https://shared-app.app.takos.jp" },
    workspaceOutputs: { url: "https://shared-app.app.takos.jp" },
    spaceOutputs: { url: "https://shared-app.app.takos.jp" },
    outputDigest: "sha256:active",
    createdAt: "2026-06-06T00:01:00.000Z",
  });
  await store.putInstallation({
    ...active.installation,
    status: "active",
    currentStateGeneration: 1,
    currentOutputSnapshotId: "out_active",
  });

  const challenger = await seedInstallationModel(store, {
    spaceId: "space_challenger",
    sourceId: "src_challenger",
    snapshotId: "snap_challenger",
    installConfigId: "cfg_challenger",
    installationId: "inst_challenger",
    name: "Shared App Challenger",
    environment: "preview",
    installConfig: {
      variableMapping: {
        worker_name: "shared-app",
        app_url: null,
        cloudflare: {
          account_id: null,
          api_base_url: null,
        },
      },
      catalog: {
        order: 100,
        surface: "service",
        kind: "worker",
        provider: "cloudflare",
        suggestedName: "shared-app",
        badge: { ja: "追加候補", en: "Installable" },
        name: { ja: "Shared App", en: "Shared App" },
        description: { ja: "テスト", en: "Test" },
        inputs: [],
        installExperience: {
          publicEndpoint: {
            subdomainVariable: "worker_name",
            urlVariable: "app_url",
            baseDomain: "app.takos.jp",
          },
        },
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_challenger",
      challenger.installation.spaceId,
    ),
    scopeHints: {
      managedProvider: true,
      providerBaseUrl: "https://app.takosumi.com/compat/cloudflare/client/v4",
      accountId: "ts_acc_takosumi_cloud",
    },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_challenger",
    spaceId: challenger.installation.spaceId,
    installationId: challenger.installation.id,
    environment: challenger.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_challenger",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  await expect(
    controller.createInstallationPlan(challenger.installation.id),
  ).rejects.toThrow("app_hostname_unavailable: already exists");
});

test("managed Cloudflare host claim ignores unapplied pending Capsules", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const first = await seedInstallationModel(store, {
    spaceId: "space_first",
    sourceId: "src_first",
    snapshotId: "snap_first",
    installConfigId: "cfg_first",
    installationId: "inst_first",
    name: "Shared App",
    environment: "preview",
    installConfig: {
      variableMapping: {
        worker_name: "shared-app",
        app_url: null,
        cloudflare: {
          account_id: null,
          api_base_url: null,
        },
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_first",
      first.installation.spaceId,
    ),
    scopeHints: {
      managedProvider: true,
      providerBaseUrl: "https://app.takosumi.com/compat/cloudflare/client/v4",
      accountId: "ts_acc_takosumi_cloud",
    },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_first",
    spaceId: first.installation.spaceId,
    installationId: first.installation.id,
    environment: first.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_first",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const second = await seedInstallationModel(store, {
    spaceId: "space_second",
    sourceId: "src_second",
    snapshotId: "snap_second",
    installConfigId: "cfg_second",
    installationId: "inst_second",
    name: "Shared App",
    environment: "preview",
    installConfig: {
      variableMapping: {
        worker_name: "shared-app",
        app_url: null,
        cloudflare: {
          account_id: null,
          api_base_url: null,
        },
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_second",
      second.installation.spaceId,
    ),
    scopeHints: {
      managedProvider: true,
      providerBaseUrl: "https://app.takosumi.com/compat/cloudflare/client/v4",
      accountId: "ts_acc_takosumi_cloud",
    },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_second",
    spaceId: second.installation.spaceId,
    installationId: second.installation.id,
    environment: second.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_second",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createInstallationPlan(
    second.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
});

test("Deployment read projection hides app.takos.jp URLs owned by another Capsule", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const stale = await seedInstallationModel(store, {
    spaceId: "space_stale",
    sourceId: "src_stale",
    snapshotId: "snap_stale",
    installConfigId: "cfg_stale",
    installationId: "inst_stale",
    name: "Shared App Stale",
    environment: "preview",
  });
  const owner = await seedInstallationModel(store, {
    spaceId: "space_owner",
    sourceId: "src_owner",
    snapshotId: "snap_owner",
    installConfigId: "cfg_owner",
    installationId: "inst_owner",
    name: "Shared App Owner",
    environment: "preview",
  });
  await store.reservePublicHost({
    hostname: "shared-app.app.takos.jp",
    workspaceId: owner.installation.spaceId,
    installationId: owner.installation.id,
    installationName: owner.installation.name,
    now: "2026-06-06T00:00:00.000Z",
  });
  const deployment: Deployment = {
    id: "dep_stale",
    spaceId: stale.installation.spaceId,
    installationId: stale.installation.id,
    environment: stale.installation.environment,
    applyRunId: "apply_stale",
    sourceSnapshotId: stale.snapshot.id,
    stateGeneration: 1,
    outputSnapshotId: "out_stale",
    outputsPublic: {
      url: "https://shared-app.app.takos.jp",
      app_deployment: {
        url: "https://shared-app.app.takos.jp",
        status: "ready",
      },
      health: "ready",
    },
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putDeployment(deployment);
  await store.putInstallation({
    ...stale.installation,
    status: "active",
    currentDeploymentId: deployment.id,
  });
  const controller = controllerWith(store, runner);

  const outputs = await controller.listDeploymentOutputs(stale.installation.id);
  expect(outputs.outputs).toEqual([
    {
      name: "app_deployment",
      kind: "app_deployment",
      value: { status: "ready" },
      sensitive: false,
    },
    {
      name: "health",
      kind: "health",
      value: "ready",
      sensitive: false,
    },
  ]);
  const projected = await controller.getDeployment(deployment.id);
  expect(projected.outputsPublic).toEqual({
    app_deployment: { status: "ready" },
    health: "ready",
  });
});

test("managed Cloudflare app.takos.jp host is atomically reserved by successful plans", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const first = await seedInstallationModel(store, {
    spaceId: "space_first",
    sourceId: "src_first",
    snapshotId: "snap_first",
    installConfigId: "cfg_first",
    installationId: "inst_first",
    name: "Reserved App",
    environment: "preview",
    installConfig: {
      variableMapping: {
        worker_name: "reserved-app",
        app_url: null,
        cloudflare: {
          account_id: null,
          api_base_url: null,
        },
      },
      catalog: {
        order: 100,
        surface: "service",
        kind: "worker",
        provider: "cloudflare",
        suggestedName: "reserved-app",
        badge: { ja: "追加候補", en: "Installable" },
        name: { ja: "Reserved App", en: "Reserved App" },
        description: { ja: "テスト", en: "Test" },
        inputs: [],
        installExperience: {
          publicEndpoint: {
            subdomainVariable: "worker_name",
            urlVariable: "app_url",
            baseDomain: "app.takos.jp",
          },
        },
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_first",
      first.installation.spaceId,
    ),
    scopeHints: {
      managedProvider: true,
      providerBaseUrl: "https://app.takosumi.com/compat/cloudflare/client/v4",
      accountId: "ts_acc_takosumi_cloud",
    },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_first",
    spaceId: first.installation.spaceId,
    installationId: first.installation.id,
    environment: first.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_first",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const firstPlan = await controller.createInstallationPlan(
    first.installation.id,
  );
  expect(firstPlan.planRun.status).toEqual("succeeded");

  const second = await seedInstallationModel(store, {
    spaceId: "space_second",
    sourceId: "src_second",
    snapshotId: "snap_second",
    installConfigId: "cfg_second",
    installationId: "inst_second",
    name: "Reserved App",
    environment: "preview",
    installConfig: {
      variableMapping: {
        worker_name: "reserved-app",
        app_url: null,
        cloudflare: {
          account_id: null,
          api_base_url: null,
        },
      },
      catalog: {
        order: 100,
        surface: "service",
        kind: "worker",
        provider: "cloudflare",
        suggestedName: "reserved-app",
        badge: { ja: "追加候補", en: "Installable" },
        name: { ja: "Reserved App", en: "Reserved App" },
        description: { ja: "テスト", en: "Test" },
        inputs: [],
        installExperience: {
          publicEndpoint: {
            subdomainVariable: "worker_name",
            urlVariable: "app_url",
            baseDomain: "app.takos.jp",
          },
        },
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_second",
      second.installation.spaceId,
    ),
    scopeHints: {
      managedProvider: true,
      providerBaseUrl: "https://app.takosumi.com/compat/cloudflare/client/v4",
      accountId: "ts_acc_takosumi_cloud",
    },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_second",
    spaceId: second.installation.spaceId,
    installationId: second.installation.id,
    environment: second.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_second",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });

  await expect(
    controller.createInstallationPlan(second.installation.id),
  ).rejects.toThrow("app_hostname_unavailable: already exists");
});

test("managed Cloudflare host claim skips corrupt historical Capsules", async () => {
  class CorruptHistoricalOutputStore extends InMemoryOpenTofuDeploymentStore {
    override getLatestOutputSnapshot(
      installationId: string,
    ): ReturnType<InMemoryOpenTofuDeploymentStore["getLatestOutputSnapshot"]> {
      if (installationId === "inst_corrupt") {
        return Promise.reject(new Error("corrupt historical output row"));
      }
      return super.getLatestOutputSnapshot(installationId);
    }
  }

  const store = new CorruptHistoricalOutputStore();
  const runner = recordingRunner();
  const corrupt = await seedInstallationModel(store, {
    spaceId: "space_corrupt",
    sourceId: "src_corrupt",
    snapshotId: "snap_corrupt",
    installConfigId: "cfg_corrupt",
    installationId: "inst_corrupt",
    name: "Corrupt Old App",
    environment: "preview",
    installConfig: {
      variableMapping: {
        worker_name: "fresh-app",
        app_url: null,
        cloudflare: {
          account_id: null,
          api_base_url: null,
        },
      },
      catalog: {
        order: 100,
        surface: "service",
        kind: "worker",
        provider: "cloudflare",
        suggestedName: "fresh-app",
        badge: { ja: "追加候補", en: "Installable" },
        name: { ja: "Fresh App", en: "Fresh App" },
        description: { ja: "テスト", en: "Test" },
        inputs: [],
        installExperience: {
          publicEndpoint: {
            subdomainVariable: "worker_name",
            urlVariable: "app_url",
            baseDomain: "app.takos.jp",
          },
        },
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_corrupt",
      corrupt.installation.spaceId,
    ),
    scopeHints: {
      managedProvider: true,
      providerBaseUrl: "https://app.takosumi.com/compat/cloudflare/client/v4",
      accountId: "ts_acc_takosumi_cloud",
    },
  });
  await store.putInstallation({
    ...corrupt.installation,
    status: "active",
    currentStateGeneration: 1,
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_corrupt",
    spaceId: corrupt.installation.spaceId,
    installationId: corrupt.installation.id,
    environment: corrupt.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_corrupt",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });

  const fresh = await seedInstallationModel(store, {
    spaceId: "space_fresh",
    sourceId: "src_fresh",
    snapshotId: "snap_fresh",
    installConfigId: "cfg_fresh",
    installationId: "inst_fresh",
    name: "Fresh App",
    environment: "preview",
    installConfig: {
      variableMapping: {
        worker_name: "fresh-app",
        app_url: null,
        cloudflare: {
          account_id: null,
          api_base_url: null,
        },
      },
      catalog: {
        order: 100,
        surface: "service",
        kind: "worker",
        provider: "cloudflare",
        suggestedName: "fresh-app",
        badge: { ja: "追加候補", en: "Installable" },
        name: { ja: "Fresh App", en: "Fresh App" },
        description: { ja: "テスト", en: "Test" },
        inputs: [],
        installExperience: {
          publicEndpoint: {
            subdomainVariable: "worker_name",
            urlVariable: "app_url",
            baseDomain: "app.takos.jp",
          },
        },
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_fresh",
      fresh.installation.spaceId,
    ),
    scopeHints: {
      managedProvider: true,
      providerBaseUrl: "https://app.takosumi.com/compat/cloudflare/client/v4",
      accountId: "ts_acc_takosumi_cloud",
    },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_fresh",
    spaceId: fresh.installation.spaceId,
    installationId: fresh.installation.id,
    environment: fresh.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_fresh",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createInstallationPlan(
    fresh.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
  expect(runner.planJobs[0]?.generatedRoot?.files["main.tf"]).toContain(
    'app_url = "https://fresh-app.app.takos.jp"',
  );
});

test("catalog managed Cloudflare Capsule uses operator fallback without implicit public endpoint", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, {
    name: "Takos Managed App",
    environment: "preview",
    installConfig: {
      variableMapping: {
        project_name: "takos-managed",
        cloudflare: {
          account_id: null,
          api_base_url: null,
        },
        app_url: null,
        worker_name: null,
      },
      catalog: {
        order: 100,
        surface: "service",
        kind: "worker",
        provider: "cloudflare",
        suggestedName: "takos",
        badge: { ja: "追加候補", en: "Installable" },
        name: { ja: "Takos", en: "Takos" },
        description: { ja: "Takos", en: "Takos" },
        inputs: [],
      },
    },
  });
  await store.putConnection({
    ...cloudflareConnection("conn_operator_managed"),
    spaceId: undefined,
    scope: "operator",
    materialization: "secret",
    scopeHints: {
      managedProvider: true,
      providerBaseUrl: "https://app.takosumi.com/compat/cloudflare/client/v4",
      accountId: "ts_acc_takosumi_cloud",
    },
  });
  const sourcesService = new SourcesService({
    store,
    now: () => new Date("2026-06-07T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_managed_catalog`,
    readCapsuleSourceFiles: () =>
      Promise.resolve([
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

variable "project_name" {
  type = string
}

variable "cloudflare" {
  type = object({
    account_id = string
    api_base_url = optional(string)
  })
}

variable "app_url" {
  type = string
}

variable "worker_name" {
  type = string
}

output "url" {
  value = var.app_url
}
`,
        },
      ]),
  });
  const profile: RunnerProfile = {
    ...multiProviderRunnerProfile([
      "registry.opentofu.org/cloudflare/cloudflare",
    ]),
    credentialRefs: [],
    requireCredentialRefs: false,
  };
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
    sourcesService,
    allowOperatorBackedProviderEnvs: true,
  });

  const { planRun } = await controller.createInstallationPlan(
    seeded.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain(
    'base_url = "https://app.takosumi.com/compat/cloudflare/client/v4"',
  );
  expect(mainTf).toContain("cloudflare = cloudflare");
  expect(mainTf).toContain(
    'cloudflare = jsondecode("{\\"account_id\\":\\"ts_acc_takosumi_cloud\\",\\"api_base_url\\":\\"https://app.takosumi.com/compat/cloudflare/client/v4\\"}")',
  );
  expect(mainTf).not.toContain("takos-managed-app-fixture.app.takos.jp");
  expect(mainTf).toContain("app_url = null");
  expect(mainTf).toContain("worker_name = null");
});

test("declared generic Capsule Cloudflare inputs and outputs are wired from source shape", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      variableMapping: {
        project_name: "yuru-e2e",
        enable_cloudflare_resources: true,
      },
      outputAllowlist: {
        url: { from: "url", type: "url" },
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_scope",
      seeded.installation.spaceId,
    ),
    scopeHints: { accountId: "acct_scope_123" },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_scope",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_scope",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const sourcesService = new SourcesService({
    store,
    now: () => new Date("2026-06-07T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_source_shape`,
    readCapsuleSourceFiles: () =>
      Promise.resolve([
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

variable "project_name" {
  type = string
}

variable "enable_cloudflare_resources" {
  type = bool
}

variable "cloudflare_account_id" {
  type = string
}

output "url" {
  value = "https://yuru-e2e.example"
}

output "cloudflare_d1_database_id" {
  value = "db-id"
}

output "cloudflare_kv_namespace_id" {
  value = "kv-id"
}

output "takosumi_release" {
  value = {
    post_apply = []
  }
}
`,
        },
        {
          path: "modules/child/variables.tf",
          text: `
variable "account_id" {
  type = string
}
`,
        },
      ]),
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
    sourcesService,
  });

  const { planRun } = await controller.createInstallationPlan(
    seeded.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
  const root = runner.planJobs[0]!.generatedRoot!.files;
  expect(root["main.tf"]).toContain('project_name = "yuru-e2e"');
  expect(root["main.tf"]).toContain("enable_cloudflare_resources = true");
  expect(root["main.tf"]).toContain('cloudflare_account_id = "acct_scope_123"');
  expect(root["main.tf"]).not.toContain('\n  account_id = "acct_scope_123"');
  expect(root["outputs.tf"]).toContain('output "cloudflare_d1_database_id"');
  expect(root["outputs.tf"]).toContain('output "cloudflare_kv_namespace_id"');
  expect(root["outputs.tf"]!.match(/output "takosumi_release"/g)).toHaveLength(
    1,
  );
});

test("standard Git Capsule variables stay ordinary OpenTofu inputs", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      variableMapping: {
        image_ref: "registry.example.com/app@sha256:abc",
        release_tag: "v1.2.3",
        version: "1.2.3",
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_scope",
      seeded.installation.spaceId,
    ),
    scopeHints: { accountId: "acct_scope_123" },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_scope",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_scope",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createInstallationPlan(
    seeded.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
  const planJob = runner.planJobs[0]!;
  const mainTf = planJob.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain('image_ref = "registry.example.com/app@sha256:abc"');
  expect(mainTf).toContain('release_tag = "v1.2.3"');
  expect(mainTf).toContain('version = "1.2.3"');
  expect(planJob.build).toBeUndefined();
  expect(planJob.prebuiltArtifact).toBeUndefined();
});

test("explicit generic Capsule variables survive compatibility metadata filtering through apply", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const releaseImages = {
    runtime: "registry.cloudflare.com/acc/takos-worker-runtime:0.10.0-abcdef",
    executor: "registry.cloudflare.com/acc/takos-agent-executor:0.10.0-abcdef",
  };
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
    installConfig: {
      variableMapping: {
        project_name: "takos-release",
        release_container_images: releaseImages,
      },
    },
  });
  await store.putCapsuleCompatibilityReport({
    id: "caprep_no_release_images",
    sourceId: seeded.source.id,
    sourceSnapshotId: seeded.snapshot.id,
    level: "ready",
    findings: [],
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
        allowed: true,
      },
    ],
    dataSources: [],
    provisioners: [],
    rootModuleVariables: ["project_name"],
    rootModuleOutputs: ["takosumi_release", "url"],
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan(
    seeded.installation.id,
    {},
    { compatibilityReportId: "caprep_no_release_images" },
  );

  expect(planRun.status).toEqual("succeeded");
  const planMainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(planMainTf).toContain('project_name = "takos-release"');
  expect(planMainTf).toContain("release_container_images = jsondecode");
  expect(planMainTf).toContain("takos-worker-runtime:0.10.0-abcdef");
  expect(planMainTf).toContain("takos-agent-executor:0.10.0-abcdef");

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toEqual("succeeded");
  expect(runner.applyJobs).toHaveLength(1);
  expect(runner.applyJobs[0]!.generatedRoot!.files["main.tf"]).toEqual(
    planMainTf,
  );
});

test("explicit Cloudflare Capsule variables override provider scope hint defaults", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedInstallationModel(store, {
    environment: "preview",
    installConfig: {
      variableMapping: {
        cloudflare: { account_id: "acct_explicit_456", zone_id: "zone_789" },
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_scope",
      seeded.installation.spaceId,
    ),
    scopeHints: { accountId: "acct_scope_123" },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_scope",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_scope",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan(
    seeded.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain('\\"account_id\\":\\"acct_explicit_456\\"');
  expect(mainTf).toContain('\\"zone_id\\":\\"zone_789\\"');
  expect(mainTf).not.toContain("acct_scope_123");
  expect(mainTf).not.toContain("fixture-provider-token");
});

test("installation plan treats sourceArchive as the selected module subtree", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
  });
  await store.putSource({
    ...seeded.source,
    defaultPath: "deploy/opentofu",
  });
  await store.putSourceSnapshot({
    ...seeded.snapshot,
    path: "deploy/opentofu",
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan(
    seeded.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.sourceSnapshotId).toEqual(seeded.snapshot.id);
  expect(planRun.source.kind).toEqual("git");
  expect(planRun.source).toHaveProperty(
    "commit",
    seeded.snapshot.resolvedCommit,
  );
  expect("modulePath" in planRun.source).toBe(false);
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]?.sourceArchive).toEqual({
    objectKey: ARCHIVE_KEY,
    digest: FIXTURE_ARCHIVE_DIGEST,
  });
  expect("modulePath" in runner.planJobs[0]!.planRun.source).toBe(false);
});

test("installation plan resolves the latest SourceSnapshot for the Source ref and path", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
  });
  const modulePath = "deploy/opentofu";
  const selectedArchiveKey =
    "spaces/space_test/sources/src_fixture/snapshots/snap_module_path/source.tar.zst";
  await store.putSource({
    ...seeded.source,
    defaultPath: modulePath,
  });
  await store.putSourceSnapshot({
    ...seeded.snapshot,
    id: "snap_module_path",
    path: modulePath,
    archiveObjectKey: selectedArchiveKey,
    fetchedByRunId: "run_module_path_sync",
    fetchedAt: "2026-06-06T00:00:01.000Z",
  });
  await store.putSourceSnapshot({
    ...seeded.snapshot,
    id: "snap_wrong_path_newer",
    path: ".",
    archiveObjectKey:
      "spaces/space_test/sources/src_fixture/snapshots/snap_wrong_path_newer/source.tar.zst",
    fetchedByRunId: "run_wrong_path_sync",
    fetchedAt: "2026-06-06T00:00:02.000Z",
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan(
    seeded.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.sourceSnapshotId).toEqual("snap_module_path");
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]?.sourceArchive).toEqual({
    objectKey: selectedArchiveKey,
    digest: FIXTURE_ARCHIVE_DIGEST,
  });
});

test("installation destroy-plan pins the active deployment SourceSnapshot instead of latest Git snapshot", async () => {
  const { store, runner, controller } = await seededController();

  const create = await controller.createInstallationPlan("inst_fixture");
  const created = await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });
  expect(created.installation?.currentDeploymentId).toBeDefined();

  const newerArchiveKey =
    "spaces/space_test/sources/src_fixture/snapshots/snap_newer_after_apply/source.tar.zst";
  await store.putSourceSnapshot({
    id: "snap_newer_after_apply",
    origin: "git",
    spaceId: "space_test",
    sourceId: "src_fixture",
    url: "https://git.example.com/example/app.git",
    ref: "main",
    resolvedCommit: "bbbbbb0123456789abcdef0123456789abcdef01",
    path: ".",
    archiveObjectKey: newerArchiveKey,
    archiveDigest: FIXTURE_ARCHIVE_DIGEST,
    archiveSizeBytes: 1024,
    fetchedByRunId: "run_newer_after_apply_sync",
    fetchedAt: "2026-06-06T00:00:10.000Z",
  });

  const destroy =
    await controller.createInstallationDestroyPlan("inst_fixture");

  expect(destroy.planRun.operation).toEqual("destroy");
  expect(destroy.planRun.sourceSnapshotId).toEqual("snap_fixture");
  expect(destroy.planRun.status).toEqual("waiting_approval");
  expect(runner.planJobs).toHaveLength(2);
  expect(runner.planJobs[1]?.sourceArchive).toEqual({
    objectKey: ARCHIVE_KEY,
    digest: FIXTURE_ARCHIVE_DIGEST,
  });
  expect(runner.planJobs[1]?.sourceArchive?.objectKey).not.toEqual(
    newerArchiveKey,
  );
});

test("installation plan uses InstallConfig modulePath inside a repo-root SourceSnapshot", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
    installConfig: {
      modulePath: "deploy/opentofu",
    },
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan(
    seeded.installation.id,
  );

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.source.kind).toEqual("git");
  expect(planRun.source).toHaveProperty("modulePath", "deploy/opentofu");
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]!.planRun.source).toHaveProperty(
    "modulePath",
    "deploy/opentofu",
  );
});

test("installation queued plan fails before credential mint when generated-root sidecar is missing", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
  });
  await putConnectionWithProviderEnv(store, {
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
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_missing_sidecar",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_missing_sidecar",
      },
    ],
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
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
  });
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
  const seeded = await seedRunnableInstallationModel(store, {
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
  await seedRunnableInstallationModel(store, {
    environment: "preview",
    installConfig: {
      modulePath: "deploy/opentofu",
    },
  });
  const sourceFileReadOptions: unknown[] = [];
  const sourcesService = new SourcesService({
    store,
    now: () => new Date("2026-06-07T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_compat_auto`,
    readCapsuleSourceFiles: (_snapshot, options) => {
      sourceFileReadOptions.push(options);
      return Promise.resolve([
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
      ]);
    },
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
  expect(sourceFileReadOptions).toEqual([{ modulePath: "deploy/opentofu" }]);
  expect(runner.planJobs).toHaveLength(1);
});

test("installation plan reuses a preflight CompatibilityReport hint without rechecking source files", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
    installConfig: {
      variableMapping: {
        project_name: "yuru-e2e",
        enable_cloudflare_resources: true,
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_scope",
      seeded.installation.spaceId,
    ),
    scopeHints: {
      accountId: "acct_scope_123",
      workersSubdomain: "team-workers",
    },
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_cloudflare_scope",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_scope",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putCapsuleCompatibilityReport({
    id: "caprep_preflight",
    sourceId: seeded.source.id,
    sourceSnapshotId: seeded.snapshot.id,
    level: "ready",
    findings: [],
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
        allowed: true,
      },
    ],
    dataSources: [],
    provisioners: [],
    rootModuleVariables: [
      "cloudflare_account_id",
      "cloudflare_workers_subdomain",
      "enable_cloudflare_resources",
      "project_name",
    ],
    rootModuleOutputs: ["takosumi_release", "worker_name", "url"],
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  let sourceFileReadCount = 0;
  const sourcesService = new SourcesService({
    store,
    now: () => new Date("2026-06-07T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_unexpected`,
    readCapsuleSourceFiles: () => {
      sourceFileReadCount += 1;
      return [];
    },
  });
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    sourcesService,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createInstallationPlan(
    "inst_fixture",
    {},
    { compatibilityReportId: "caprep_preflight" },
  );

  expect(planRun.status).toBe("succeeded");
  expect(planRun.compatibilityReportId).toBe("caprep_preflight");
  const installation = await store.getInstallation("inst_fixture");
  expect(installation?.compatibilityReportId).toBe("caprep_preflight");
  expect(installation?.compatibilityStatus).toBe("ready");
  expect(sourceFileReadCount).toBe(0);
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]?.generatedRoot?.moduleFiles).toBeUndefined();
  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  const outputsTf = runner.planJobs[0]!.generatedRoot!.files["outputs.tf"]!;
  expect(mainTf).toContain('project_name = "yuru-e2e"');
  expect(mainTf).toContain("enable_cloudflare_resources = true");
  expect(mainTf).toContain('cloudflare_account_id = "acct_scope_123"');
  expect(mainTf).toContain('cloudflare_workers_subdomain = "team-workers"');
  expect(mainTf).not.toContain("fixture-provider-token");
  expect(outputsTf).toContain('output "takosumi_release"');
});

test("installation plan reuses the latest matching preflight CompatibilityReport when the client omits the hint", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
  });
  await store.putCapsuleCompatibilityReport({
    id: "caprep_preflight",
    sourceId: seeded.source.id,
    sourceSnapshotId: seeded.snapshot.id,
    level: "ready",
    findings: [],
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
        allowed: true,
      },
    ],
    dataSources: [],
    provisioners: [],
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  let sourceFileReadCount = 0;
  const sourcesService = new SourcesService({
    store,
    now: () => new Date("2026-06-07T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_unexpected`,
    readCapsuleSourceFiles: () => {
      sourceFileReadCount += 1;
      return [];
    },
  });
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    sourcesService,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createInstallationPlan(
    "inst_fixture",
    {},
  );

  expect(planRun.status).toBe("succeeded");
  expect(planRun.compatibilityReportId).toBe("caprep_preflight");
  const installation = await store.getInstallation("inst_fixture");
  expect(installation?.compatibilityReportId).toBe("caprep_preflight");
  expect(installation?.compatibilityStatus).toBe("ready");
  expect(sourceFileReadCount).toBe(1);
  expect(runner.planJobs).toHaveLength(1);
});

test("installation plan ignores a stale cached CompatibilityReport when a matching preflight report exists", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
  });
  await store.putCapsuleCompatibilityReport({
    id: "caprep_stale_cached",
    sourceId: seeded.source.id,
    installationId: seeded.installation.id,
    sourceSnapshotId: "snap_old",
    level: "ready",
    findings: [],
    providers: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putInstallation({
    ...seeded.installation,
    compatibilityReportId: "caprep_stale_cached",
    compatibilityStatus: "ready",
  });
  await store.putCapsuleCompatibilityReport({
    id: "caprep_current_preflight",
    sourceId: seeded.source.id,
    sourceSnapshotId: seeded.snapshot.id,
    level: "ready",
    findings: [],
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
        allowed: true,
      },
    ],
    dataSources: [],
    provisioners: [],
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  const sourcesService = new SourcesService({
    store,
    now: () => new Date("2026-06-07T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_unexpected`,
    readCapsuleSourceFiles: () => {
      throw new Error("matching preflight report should avoid source recheck");
    },
  });
  const controller = new OpenTofuDeploymentController({
    store,
    runner,
    sourcesService,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createInstallationPlan(
    "inst_fixture",
    {},
  );

  expect(planRun.status).toBe("succeeded");
  expect(planRun.compatibilityReportId).toBe("caprep_current_preflight");
  const installation = await store.getInstallation("inst_fixture");
  expect(installation?.compatibilityReportId).toBe("caprep_current_preflight");
  expect(runner.planJobs).toHaveLength(1);
});

test("installation plan dispatches normalized module files for auto-capsulized CompatibilityReport", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedRunnableInstallationModel(store, { environment: "preview" });
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
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
  });
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
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
  });
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

test("generic OpenTofu runner profile derives pre-init requiredProviders from ProviderBinding before dispatch", async () => {
  const provider = "registry.opentofu.org/vercel/vercel";
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner({
    requiredProviders: [provider],
    providerInstallation: [
      {
        provider,
        mirrored: true,
        installationMethod: "filesystem_mirror",
        attested: true,
        attestationMethod: "forced_filesystem_mirror_init",
        mirrorPath:
          "/opt/opentofu/provider-mirror/registry.opentofu.org/vercel/vercel",
      },
    ],
  });
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
  });
  await putConnectionWithProviderEnv(store, {
    id: "conn_vercel",
    spaceId: seeded.installation.spaceId,
    provider,
    kind: "generic_env_provider",
    scope: "space",
    status: "verified",
    envNames: ["VERCEL_API_TOKEN"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    verifiedAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_vercel",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider,
        alias: "main",
        connectionId: "conn_vercel",
      },
    ],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  const genericProfile: RunnerProfile = {
    id: "generic-opentofu-provider",
    name: "Generic OpenTofu provider",
    substrate: "cloudflare-containers",
    allowedProviders: ["*"],
    stateBackend: { kind: "operator-managed", ref: "r2://state" },
    stateLock: { kind: "native" },
    networkPolicy: { mode: "operator-managed" },
    secretExposure: {
      providerCredentials: "runner-only",
      tenantWorkerOperatorSecrets: "forbidden",
      redactLogs: true,
      blockSensitiveOutputs: true,
    },
  };
  const controller = controllerWith(store, runner, {
    runnerProfiles: [genericProfile],
    defaultRunnerProfileId: genericProfile.id,
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(runner.planJobs[0]?.planRun.requiredProviders).toEqual([provider]);
  expect(planRun.requiredProviders).toEqual([provider]);
  expect(planRun.policy.status).toEqual("passed");
});

test("generic OpenTofu runner profile permits direct provider install by default", async () => {
  const provider = "registry.opentofu.org/vercel/vercel";
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner({
    requiredProviders: [provider],
    providerInstallation: [
      {
        provider,
        mirrored: false,
        installationMethod: "direct",
      },
    ],
  });
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
  });
  await putConnectionWithProviderEnv(store, {
    id: "conn_vercel_direct_profile",
    spaceId: seeded.installation.spaceId,
    provider,
    kind: "generic_env_provider",
    scope: "space",
    status: "verified",
    envNames: ["VERCEL_API_TOKEN"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    verifiedAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_vercel_direct_profile",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider,
        alias: "main",
        connectionId: "conn_vercel_direct_profile",
      },
    ],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  const genericProfile: RunnerProfile = {
    id: "generic-opentofu-provider",
    name: "Generic OpenTofu provider",
    substrate: "cloudflare-containers",
    allowedProviders: ["*"],
    stateBackend: { kind: "operator-managed", ref: "r2://state" },
    stateLock: { kind: "native" },
    networkPolicy: { mode: "operator-managed" },
    labels: { "takosumi.com/provider-surface": "generic" },
    secretExposure: {
      providerCredentials: "runner-only",
      tenantWorkerOperatorSecrets: "forbidden",
      redactLogs: true,
      blockSensitiveOutputs: true,
    },
  };
  const controller = controllerWith(store, runner, {
    runnerProfiles: [genericProfile],
    defaultRunnerProfileId: genericProfile.id,
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(runner.planJobs[0]?.providerInstallationPolicy).toBeUndefined();
  expect(planRun.status).toEqual("succeeded");
  expect(planRun.policy.status).toEqual("passed");
});

test("generic Capsule installation plan allows provider-free modules without ProviderConnection", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner({
    requiredProviders: [],
    providerInstallation: [],
  });
  await seedInstallationModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toBe("succeeded");
  expect(planRun.requiredProviders).toEqual([]);
  expect(planRun.policy.status).toBe("passed");
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]?.planRun.requiredProviders).toEqual([]);
});

test("generic env ProviderBinding blocks low-level plan requests that omit requiredProviders", async () => {
  const provider = "registry.opentofu.org/vercel/vercel";
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
  });
  await putConnectionWithProviderEnv(store, {
    id: "conn_vercel_direct",
    spaceId: seeded.installation.spaceId,
    provider,
    kind: "generic_env_provider",
    scope: "space",
    status: "verified",
    envNames: ["VERCEL_API_TOKEN"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    verifiedAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_vercel_direct",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider,
        alias: "main",
        connectionId: "conn_vercel_direct",
      },
    ],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  const genericProfile: RunnerProfile = {
    id: "generic-opentofu-provider",
    name: "Generic OpenTofu provider",
    substrate: "cloudflare-containers",
    allowedProviders: ["*"],
    stateBackend: { kind: "operator-managed", ref: "r2://state" },
    stateLock: { kind: "native" },
    networkPolicy: { mode: "operator-managed" },
    secretExposure: {
      providerCredentials: "runner-only",
      tenantWorkerOperatorSecrets: "forbidden",
      redactLogs: true,
      blockSensitiveOutputs: true,
    },
  };
  const controller = controllerWith(store, runner, {
    runnerProfiles: [genericProfile],
    defaultRunnerProfileId: genericProfile.id,
  });

  const { planRun } = await controller.createPlanRun({
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    source: {
      kind: "git",
      url: seeded.source.url,
      ref: seeded.source.defaultRef,
      modulePath: seeded.source.defaultPath,
    },
    runnerProfileId: genericProfile.id,
    requiredProviders: [],
  });

  expect(planRun.status).toEqual("failed");
  expect(planRun.policy.status).toEqual("blocked");
  expect(planRun.policy.reasons.join("\n")).toContain(
    "generic-env provider bindings on runner profile generic-opentofu-provider require requiredProviders before OpenTofu init",
  );
  expect(runner.planJobs).toHaveLength(0);
});

test("generic Capsule plan creation blocks stale CompatibilityReport as policy", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
  });
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
  ).rejects.toThrow("compatibility_report_snapshot_mismatch");
  expect(runner.planJobs).toHaveLength(0);
});

test("installation apply revalidates CompatibilityReport before provider credential mint", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
  });
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
  await putConnectionWithProviderEnv(store, {
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
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_apply_guard",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_apply_guard",
      },
    ],
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

test("installation apply rejects a CompatibilityReport scoped to another Capsule before credential mint", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
  });
  const report = {
    id: "caprep_apply_scope_guard",
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
  await putConnectionWithProviderEnv(store, {
    id: "conn_apply_scope_guard",
    scope: "space",
    spaceId: seeded.installation.spaceId,
    provider: "cloudflare",
    kind: "cloudflare_api_token",
    displayName: "Apply scope guard Cloudflare",
    status: "verified",
    scopeJson: {},
    secretRef: "sec_apply_scope_guard",
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_apply_scope_guard",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_apply_scope_guard",
      },
    ],
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
  const mintCountAfterPlan = counted.mintCount;
  await store.putCapsuleCompatibilityReport({
    ...report,
    installationId: "inst_other",
  });

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(applyRun.diagnostics?.[0]?.message).toContain(
    "compatibility_report_installation_mismatch",
  );
  expect(counted.mintCount).toBe(mintCountAfterPlan);
  expect(runner.applyJobs).toHaveLength(0);
});

test("installation apply fails before credential mint when generated-root sidecar is missing", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
  });
  await putConnectionWithProviderEnv(store, {
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
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_apply_missing_sidecar",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_apply_missing_sidecar",
      },
    ],
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
  await seedRunnableInstallationModel(store, {
    installConfig: {
      policy: {
        providerLockfile: { requireDigest: true },
      },
    },
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(runner.planJobs).toHaveLength(1);
  expect(planRun.status).toBe("failed");
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
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
    installConfig: {
      policy: {
        providerInstallation: { requireMirror: true },
      },
    },
  });
  await seedProviderConnections(store, seeded.installation, {
    requiredProviders: [
      "registry.opentofu.org/cloudflare/cloudflare",
      "registry.opentofu.org/hashicorp/aws",
    ],
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(runner.planJobs).toHaveLength(1);
  expect(planRun.status).toBe("failed");
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
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(runner.planJobs[0]?.providerInstallationPolicy).toEqual({
    requireMirror: true,
  });
  expect(planRun.status).toBe("failed");
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
  const seeded = await seedRunnableInstallationModel(store, {
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
  await seedProviderConnections(store, seeded.installation, {
    requiredProviders: [
      "registry.opentofu.org/cloudflare/cloudflare",
      "registry.opentofu.org/hashicorp/aws",
    ],
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toBe("failed");
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
  const seeded = await seedRunnableInstallationModel(store, {
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
  await seedProviderConnections(store, seeded.installation, {
    requiredProviders: [
      "registry.opentofu.org/cloudflare/cloudflare",
      "registry.opentofu.org/hashicorp/aws",
    ],
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  expect(planRun.status).toBe("failed");
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
  await seedRunnableInstallationModel(store, {
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

  expect(planRun.status).toBe("failed");
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

test("release activator runs after apply with only non-sensitive outputs", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(
    {},
    {
      launch_url: {
        sensitive: false,
        value: "https://yuru-smoke-secret.example",
      },
      public_url: { sensitive: false, value: "https://public.example" },
      public_status: { sensitive: false, value: "sk-output-raw-token" },
      worker_name: { sensitive: false, value: "yuru-smoke-secret" },
      bucket_name: { sensitive: false, value: "my-bucket" },
      admin_token: { sensitive: true, value: "super-secret-token" },
    },
  );
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const activations: ReleaseActivationInput[] = [];
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: (input) => {
        activations.push(input);
        return Promise.resolve({
          status: "pending",
          kind: "operator.release",
          launchUrl: "https://x.example",
          metadata: { artifactName: "preview" },
        });
      },
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect(activations).toHaveLength(1);
  expect(activations[0]?.nonSensitiveOutputs).toEqual({
    launch_url: "https://yuru-smoke-secret.example",
    public_url: "https://public.example",
    worker_name: "yuru-smoke-secret",
    bucket_name: "my-bucket",
  });
  expect(JSON.stringify(activations[0])).not.toContain("admin_token");
  expect(JSON.stringify(activations[0])).not.toContain("super-secret-token");
  expect(JSON.stringify(activations[0])).not.toContain("sk-output-raw-token");

  const activity = (await store.listActivityEvents("space_test")).find(
    (event) => event.action === "release_activation.pending",
  );
  expect(activity).toBeDefined();
  expect(activity).toMatchObject({
    targetType: "deployment",
    runId: applyRun.id,
    metadata: {
      installationId: "inst_fixture",
      applyRunId: applyRun.id,
      outputCount: 4,
      activationKind: "operator.release",
      hasLaunchUrl: true,
      hasHealthUrl: false,
      metadataKeys: ["artifactName"],
    },
  });
  expect(JSON.stringify(activity)).not.toContain(
    "https://yuru-smoke-secret.example",
  );
  expect(JSON.stringify(activity)).not.toContain("super-secret-token");
});

test("release activator receives neutral post-apply commands as opaque argv", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(
    {},
    {
      takosumi_release: {
        sensitive: false,
        value: {
          post_apply: [
            {
              id: "activate",
              executor: "operator",
              command: ["bun", "run", "app:activate", "--target", "runtime"],
              working_directory: ".",
              timeout_seconds: 900,
              env: {
                APP_RELEASE_TARGET: "runtime",
                API_TOKEN: "sk-should-not-leak",
                DATABASE_URL: "postgres://user:pass@db.example/app",
              },
            },
          ],
        },
      },
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const activations: ReleaseActivationInput[] = [];
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: (input) => {
        activations.push(input);
        return Promise.resolve({ status: "succeeded" });
      },
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect(activations).toHaveLength(1);
  expect(activations[0]?.commands).toEqual([
    {
      id: "activate",
      phase: "post_apply",
      executor: "operator",
      command: ["bun", "run", "app:activate", "--target", "runtime"],
      workingDirectory: ".",
      timeoutSeconds: 900,
      env: { APP_RELEASE_TARGET: "runtime" },
    },
  ]);
  expect(JSON.stringify(activations[0])).not.toContain("sk-should-not-leak");
  expect(JSON.stringify(activations[0])).not.toContain("postgres://");

  const activity = (await store.listActivityEvents("space_test")).find(
    (event) => event.action === "release_activation.succeeded",
  );
  expect(activity?.metadata).toMatchObject({
    commandCount: 1,
  });
});

test("post-apply release commands fall back to OutputSnapshot workspace outputs", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const originalCommit = store.commitAppliedDeployment.bind(store);
  store.commitAppliedDeployment = (
    input: Parameters<OpenTofuDeploymentStore["commitAppliedDeployment"]>[0],
  ) => {
    if (input.outputSnapshot) {
      const mutable = input.outputSnapshot as unknown as {
        workspaceOutputs: Record<string, unknown>;
        spaceOutputs: Record<string, unknown>;
      };
      const workspaceOutputs = {
        ...mutable.workspaceOutputs,
        takosumi_release: {
          post_apply: [
            {
              id: "publish-from-snapshot",
              executor: "operator",
              command: ["bun", "run", "release"],
              working_directory: ".",
              env_allowlist: ["CLOUDFLARE_API_TOKEN"],
            },
          ],
        },
      };
      mutable.workspaceOutputs = workspaceOutputs;
      mutable.spaceOutputs = workspaceOutputs;
    }
    return originalCommit(input);
  };
  const runner = recordingRunner(
    {},
    {
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const activations: ReleaseActivationInput[] = [];
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: (input) => {
        activations.push(input);
        return Promise.resolve({ status: "succeeded" });
      },
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect(activations).toHaveLength(1);
  expect(activations[0]?.commands).toEqual([
    {
      id: "publish-from-snapshot",
      phase: "post_apply",
      executor: "operator",
      command: ["bun", "run", "release"],
      workingDirectory: ".",
    },
  ]);
});

test("runner release commands receive dispatch-only provider credentials", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(
    {},
    {
      takosumi_release: {
        sensitive: false,
        value: {
          post_apply: [
            {
              id: "publish",
              executor: "runner",
              command: ["bun", "run", "app:activate"],
              working_directory: ".",
              timeoutSeconds: "1200",
            },
          ],
        },
      },
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const activations: ReleaseActivationInput[] = [];
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: (input) => {
        activations.push(input);
        return Promise.resolve({ status: "succeeded" });
      },
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect(activations).toHaveLength(1);
  expect(activations[0]?.commands).toEqual([
    {
      id: "publish",
      phase: "post_apply",
      executor: "runner",
      command: ["bun", "run", "app:activate"],
      workingDirectory: ".",
      timeoutSeconds: 1200,
    },
  ]);
  expect(activations[0]?.credentials).toEqual({
    CLOUDFLARE_API_TOKEN: "fixture-provider-token",
  });

  const activity = (await store.listActivityEvents("space_test")).find(
    (event) => event.action === "release_activation.succeeded",
  );
  expect(JSON.stringify(activity)).not.toContain("fixture-provider-token");
});

test("operator release commands receive dispatch-only provider credentials", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(
    {},
    {
      takosumi_release: {
        sensitive: false,
        value: {
          post_apply: [
            {
              id: "publish",
              executor: "operator",
              command: ["bun", "run", "app:activate"],
              working_directory: ".",
              timeoutSeconds: "1200",
            },
          ],
        },
      },
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const activations: ReleaseActivationInput[] = [];
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: (input) => {
        activations.push(input);
        return Promise.resolve({ status: "succeeded" });
      },
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect(activations).toHaveLength(1);
  expect(activations[0]?.commands).toEqual([
    {
      id: "publish",
      phase: "post_apply",
      executor: "operator",
      command: ["bun", "run", "app:activate"],
      workingDirectory: ".",
      timeoutSeconds: 1200,
    },
  ]);
  expect(activations[0]?.credentials).toEqual({
    CLOUDFLARE_API_TOKEN: "fixture-provider-token",
  });

  const activity = (await store.listActivityEvents("space_test")).find(
    (event) => event.action === "release_activation.succeeded",
  );
  expect(JSON.stringify(activity)).not.toContain("fixture-provider-token");
});

test("release command descriptor validates only generic command shape", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(
    {},
    {
      takosumi_release: {
        sensitive: false,
        value: {
          post_apply: [
            {
              id: "app-activation-is-opaque",
              executor: "operator",
              command: ["bun", "run", "app:activate"],
              working_directory: "backend",
              env: {
                APP_RELEASE_TARGET: "production",
                BAD_NAME: "ok",
                "bad-name": "ignored",
                TAKOSUMI_OUTPUTS_JSON: "ignored",
                PATH: "/tmp/bin",
                DATABASE_URL: "postgres://user:pass@db.example/app",
                MULTILINE: "one\ntwo",
              },
            },
            {
              id: "path-escape",
              executor: "operator",
              command: ["bun", "run", "activate"],
              working_directory: "../outside",
            },
            {
              id: "absolute-path",
              executor: "operator",
              command: ["bun", "run", "activate"],
              working_directory: "/tmp",
            },
            {
              id: "control-char-argv",
              executor: "operator",
              command: ["bun", "run\nactivate"],
            },
            {
              id: "bad-timeout",
              executor: "operator",
              command: ["bun", "run", "activate"],
              timeout_seconds: 0,
            },
          ],
        },
      },
    },
  );
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const activations: ReleaseActivationInput[] = [];
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: (input) => {
        activations.push(input);
        return Promise.resolve({ status: "succeeded" });
      },
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(activations).toHaveLength(1);
  expect(activations[0]?.commands).toEqual([
    {
      id: "app-activation-is-opaque",
      phase: "post_apply",
      command: ["bun", "run", "app:activate"],
      workingDirectory: "backend",
      env: {
        APP_RELEASE_TARGET: "production",
        BAD_NAME: "ok",
      },
      executor: "operator",
    },
  ]);
  expect(JSON.stringify(activations[0])).not.toContain("postgres://");
  expect(JSON.stringify(activations[0])).not.toContain("TAKOSUMI_OUTPUTS_JSON");
  expect(JSON.stringify(activations[0])).not.toContain("../outside");
});

test("pre-destroy release commands run before OpenTofu destroy", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(
    {},
    {
      takosumi_release: {
        sensitive: false,
        value: {
          pre_destroy: [
            {
              id: "delete-worker",
              executor: "operator",
              command: ["bun", "run", "takosumi:release", "--", "--destroy"],
              working_directory: ".",
            },
          ],
        },
      },
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  const originalDestroy = runner.destroy!.bind(runner);
  const events: string[] = [];
  runner.destroy = (job) => {
    events.push("destroy");
    return originalDestroy(job);
  };
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const activations: ReleaseActivationInput[] = [];
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: (input) => {
        events.push(`activate:${input.commands[0]?.phase ?? "none"}`);
        activations.push(input);
        return Promise.resolve({ status: "succeeded" });
      },
    },
  });

  const create = await controller.createInstallationPlan("inst_fixture");
  const createApply = await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });
  expect(createApply.deployment?.outputsPublic).not.toHaveProperty(
    "takosumi_release",
  );
  const outputSnapshot = await store.getOutputSnapshot(
    createApply.deployment!.outputSnapshotId,
  );
  expect(outputSnapshot?.workspaceOutputs).toHaveProperty("takosumi_release");
  activations.length = 0;
  events.length = 0;

  const destroy =
    await controller.createInstallationDestroyPlan("inst_fixture");
  await controller.approveRun(destroy.planRun.id);
  const { applyRun } = await controller.createApplyRun({
    planRunId: destroy.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroy.planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect(runner.destroyJobs).toHaveLength(1);
  expect(events).toEqual(["activate:pre_destroy", "destroy"]);
  expect(activations).toHaveLength(1);
  expect(activations[0]?.applyRun.id).toBe(applyRun.id);
  expect(activations[0]?.sourceSnapshot?.id).toBe("snap_fixture");
  expect(activations[0]?.commands).toEqual([
    {
      id: "delete-worker",
      phase: "pre_destroy",
      executor: "operator",
      command: ["bun", "run", "takosumi:release", "--", "--destroy"],
      workingDirectory: ".",
    },
  ]);
});

test("pre-destroy release command failures do not block OpenTofu destroy", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(
    {},
    {
      takosumi_release: {
        sensitive: false,
        value: {
          pre_destroy: [
            {
              id: "delete-worker",
              executor: "operator",
              command: ["bun", "run", "takosumi:release", "--", "--destroy"],
              working_directory: ".",
            },
          ],
        },
      },
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: () =>
        Promise.resolve({
          status: "failed",
          message: "worker artifact was already absent",
        }),
    },
  });

  const create = await controller.createInstallationPlan("inst_fixture");
  await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });

  const destroy =
    await controller.createInstallationDestroyPlan("inst_fixture");
  await controller.approveRun(destroy.planRun.id);
  const { applyRun, installation } = await controller.createApplyRun({
    planRunId: destroy.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroy.planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect(runner.destroyJobs).toHaveLength(1);
  expect(installation?.status).toBe("destroyed");
  const activity = (await store.listActivityEvents("space_test")).find(
    (event) => event.action === "release_activation.failed",
  );
  expect(activity?.metadata).toMatchObject({
    commandCount: 1,
    message: "worker artifact was already absent",
  });
});

test("pre-destroy release activator skipped result is recorded when commands were declared", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(
    {},
    {
      takosumi_release: {
        sensitive: false,
        value: {
          pre_destroy: [
            {
              id: "delete-worker",
              executor: "operator",
              command: ["bun", "run", "takosumi:release", "--", "--destroy"],
              working_directory: ".",
            },
          ],
        },
      },
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: () =>
        Promise.resolve({
          status: "skipped",
          kind: "operator.release",
        }),
    },
  });

  const create = await controller.createInstallationPlan("inst_fixture");
  await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });

  const destroy =
    await controller.createInstallationDestroyPlan("inst_fixture");
  await controller.approveRun(destroy.planRun.id);
  const { applyRun, installation } = await controller.createApplyRun({
    planRunId: destroy.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroy.planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect(installation?.status).toBe("destroyed");
  const activity = (await store.listActivityEvents("space_test")).find(
    (event) =>
      event.action === "release_activation.failed" &&
      event.runId === applyRun.id,
  );
  expect(activity?.metadata).toMatchObject({
    activationKind: "operator.release",
    commandCount: 1,
    message: "release activator skipped declared pre-destroy commands",
  });
});

test("pre-destroy release commands fail destroy when no release activator is configured", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(
    {},
    {
      takosumi_release: {
        sensitive: false,
        value: {
          preDestroy: {
            commands: [
              {
                id: "delete-worker",
                command: ["bun", "run", "takosumi:release", "--destroy"],
              },
            ],
          },
        },
      },
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
  });

  const create = await controller.createInstallationPlan("inst_fixture");
  await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });
  const destroy =
    await controller.createInstallationDestroyPlan("inst_fixture");
  await controller.approveRun(destroy.planRun.id);
  const { applyRun, installation } = await controller.createApplyRun({
    planRunId: destroy.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroy.planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(runner.destroyJobs).toHaveLength(0);
  expect(installation?.status).toBe("active");
  const activity = (await store.listActivityEvents("space_test")).find(
    (event) => event.action === "release_activation.failed",
  );
  expect(activity?.metadata).toMatchObject({
    activationKind: "takosumi.release-commands@v1",
    commandCount: 1,
    message:
      "pre-destroy release commands declared but no release activator is configured",
  });
});

test("app-declared release commands stay pending when no release activator is configured", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(
    {},
    {
      takosumi_release: {
        sensitive: false,
        value: {
          post_apply: {
            commands: [
              {
                id: "publish",
                command: ["bun", "run", "release"],
              },
            ],
          },
        },
      },
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  const activity = (await store.listActivityEvents("space_test")).find(
    (event) => event.action === "release_activation.pending",
  );
  expect(activity).toBeDefined();
  expect(activity?.metadata).toMatchObject({
    activationKind: "takosumi.release-commands@v1",
    commandCount: 1,
    message:
      "post-apply release commands declared but no release activator is configured",
  });
});

test("release activator failure records activity without failing apply", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: () =>
        Promise.reject(new Error("activation healthcheck failed")),
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  const activity = (await store.listActivityEvents("space_test")).find(
    (event) => event.action === "release_activation.failed",
  );
  expect(activity).toBeDefined();
  const deployment = await store.getDeployment(activity!.targetId);
  expect(deployment?.status).toBe("active");
  expect(activity?.metadata).toMatchObject({
    installationId: "inst_fixture",
    applyRunId: applyRun.id,
    outputCount: 3,
    message: "activation healthcheck failed",
  });
});

test("release activator skipped result is recorded when commands were declared", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(
    {},
    {
      takosumi_release: {
        sensitive: false,
        value: {
          post_apply: [
            {
              id: "publish",
              executor: "operator",
              command: ["bun", "run", "release"],
            },
          ],
        },
      },
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: () =>
        Promise.resolve({
          status: "skipped",
          kind: "operator.release",
        }),
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  const activity = (await store.listActivityEvents("space_test")).find(
    (event) => event.action === "release_activation.failed",
  );
  expect(activity?.metadata).toMatchObject({
    activationKind: "operator.release",
    commandCount: 1,
    message: "release activator skipped declared post-apply commands",
  });
});

test("release activator skipped result without commands remains a no-op", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner(
    {},
    {
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: () =>
        Promise.resolve({
          status: "skipped",
          kind: "operator.release",
        }),
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect(
    (await store.listActivityEvents("space_test")).some((event) =>
      event.action.startsWith("release_activation."),
    ),
  ).toBe(false);
});

test("Space-owned Provider Connection apply is not capped by Cloud-only managed-resource policy", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableInstallationModel(store, {
    environment: "preview",
  });
  // A Space-owned (self-host style) Connection bound explicitly: the run resolves
  // to mode "connection" with a SPACE-scoped Connection, never the operator key,
  // so even far past the cap the apply is admitted.
  await putConnectionWithProviderEnv(store, {
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
  await store.putInstallationProviderEnvBindingSet({
    id: "profile_self",
    spaceId: seeded.installation.spaceId,
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
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
  });

  // A sibling Installation can carry an unrelated generation count; OSS
  // Provider Connections are not governed by Cloud-only managed-resource caps.
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
    spaceId: "user_test",
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
  const usageEvents = await store.listUsageEvents("user_test");
  expect(usageEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        runId: applyRun.id,
        kind: "operation",
        credits: 1,
        resourceMetadata: {
          source_workspace_id: "space_test",
        },
        source: "runner",
      }),
    ]),
  );
  const runnerUsageEvents = usageEvents.filter(
    (event) => event.kind === "runner_minute",
  );
  expect(runnerUsageEvents).toEqual([
    expect.objectContaining({
      runId: planRun.id,
      quantity: expect.any(Number),
      source: "runner",
    }),
    expect.objectContaining({
      runId: applyRun.id,
      quantity: expect.any(Number),
      source: "runner",
    }),
  ]);
  for (const event of runnerUsageEvents) {
    const usdMicros = runnerMinuteUsdMicros(event.quantity);
    expect(event.usdMicros).toBe(usdMicros);
    expect(event.credits).toBe(usdMicrosToLegacyCredits(usdMicros));
    expect(event.usdMicros).toBeLessThan(10_000);
  }
});

async function showbackEstimatedCreditsFor(
  planResourceChanges: readonly PlanResourceChange[],
): Promise<number> {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner({
    planResourceChanges: [...planResourceChanges],
  });
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner);
  const space = await store.getSpace("space_test");
  await store.putSpace({
    ...space!,
    billingSettings: { mode: "showback", provider: "none" },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  // The plan completed `succeeded` (a delete/replace `requiresApproval` change is
  // a display signal, not an approval-mandatory gate, so it does not park
  // `waiting_approval`) and reserved credits.
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

test("billing block is delegated to the injected enforcement port (Seam B)", async () => {
  // OSS billing is showback-only; the BLOCK decision now lives in the Cloud
  // `billingEnforcement` port. This proves the controller (a) consults the port
  // at plan time and (b) folds a non-empty `reasons` into the plan's policy
  // verdict so the run fails — without OSS itself owning any balance/enforce
  // logic. The Space keeps a valid OSS `showback` mode (NOT the removed
  // `enforce`); the injected port alone decides to block.
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const reservePlanBillingCalls: BillingReservationContext[] = [];
  const billingEnforcement: BillingEnforcement = {
    reservePlanBilling: async (ctx) => {
      reservePlanBillingCalls.push(ctx);
      return {
        reasons: ["USD balance reservation failed: available 0 < estimated 1"],
        audit: { mode: "enforce", reservationStatus: "insufficient_credits" },
      };
    },
    assertReservationSatisfied: async () => {},
    captureRunBilling: async () => {},
    releaseReservation: async () => {},
  };
  const controller = controllerWith(store, runner, { billingEnforcement });
  const space = await store.getSpace("space_test");
  await store.putSpace({
    ...space!,
    billingSettings: { mode: "showback", provider: "none" },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  // The runner still PLANNED — billing only gates the verdict, not the plan run.
  expect(runner.planJobs).toHaveLength(1);
  // The controller consulted the injected port at plan time, in showback mode,
  // having already passed layered policy (so the block is genuinely billing's).
  expect(reservePlanBillingCalls).toHaveLength(1);
  expect(reservePlanBillingCalls[0]).toMatchObject({
    spaceId: "space_test",
    runId: planRun.id,
    installationId: "inst_fixture",
    mode: "showback",
    policyPassedBeforeBilling: true,
  });
  // ...and folded the port's blocking reason into the FAILED plan's policy.
  expect(planRun.status).toBe("failed");
  expect(planRun.policy.reasons.join("\n")).toContain(
    "USD balance reservation failed",
  );
  // A blocked plan never records a showback reservation row.
  expect(await store.getCreditReservationForRun(planRun.id)).toBeUndefined();
});

test("controller drives the enforcement port through plan reserve and apply capture (Seam B)", async () => {
  // Seam B lifecycle: the OSS controller records the showback ledger AND drives
  // the injected Cloud port — `reservePlanBilling` at plan time, then
  // `captureRunBilling` at apply time (with `releaseReservation` reserved for
  // the failure path). All USD-balance math is the port's; OSS only records the
  // transparent showback CreditReservation + UsageEvent.
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const profile = multiProviderRunnerProfile();
  const reservePlanBillingCalls: BillingReservationContext[] = [];
  const captureRunBillingCalls: BillingCaptureContext[] = [];
  const releaseReservationCalls: BillingReleaseContext[] = [];
  const billingEnforcement: BillingEnforcement = {
    reservePlanBilling: async (ctx) => {
      reservePlanBillingCalls.push(ctx);
      return { reasons: [] };
    },
    assertReservationSatisfied: async () => {},
    captureRunBilling: async (ctx) => {
      captureRunBillingCalls.push(ctx);
    },
    releaseReservation: async (ctx) => {
      releaseReservationCalls.push(ctx);
    },
  };
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
    billingEnforcement,
  });
  const space = await store.getSpace("space_test");
  await store.putSpace({
    ...space!,
    billingSettings: { mode: "showback", provider: "none" },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");

  // Plan time: port consulted in showback mode, and the showback CreditReservation
  // ledger row recorded (estimate pins to BASE=1 for the no-change fixture plan).
  expect(planRun.status).toBe("succeeded");
  expect(reservePlanBillingCalls).toHaveLength(1);
  expect(reservePlanBillingCalls[0]).toMatchObject({
    spaceId: "space_test",
    runId: planRun.id,
    installationId: "inst_fixture",
    mode: "showback",
  });
  expect(await store.getCreditReservationForRun(planRun.id)).toMatchObject({
    spaceId: "user_test",
    status: "reserved",
    mode: "showback",
    estimatedCredits: 1,
  });

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  // Apply time: capture delegated to the port, the showback reservation flipped
  // to `captured`, and a showback UsageEvent recorded against the apply run.
  expect(applyRun.status).toBe("succeeded");
  expect(captureRunBillingCalls).toHaveLength(1);
  expect(captureRunBillingCalls[0]).toMatchObject({
    spaceId: "space_test",
    runId: planRun.id,
    applyRunId: applyRun.id,
  });
  expect((await store.getCreditReservationForRun(planRun.id))?.status).toBe(
    "captured",
  );
  const usageEvents = await store.listUsageEvents("user_test");
  expect(
    usageEvents.some(
      (event) => event.runId === applyRun.id && event.kind === "operation",
    ),
  ).toBe(true);
  // The success path never releases the reservation.
  expect(releaseReservationCalls).toHaveLength(0);
});

test("resource meter usage reconciliation is idempotent and rejects runner source", async () => {
  const { store, controller } = await seededController();

  const first = await controller.recordMeteredUsage("space_test", {
    installationId: "inst_fixture",
    kind: "backup_storage_gb_hour",
    quantity: 12.5,
    credits: 3,
    source: "resource_meter",
    idempotencyKey: "meter:inst_fixture:storage:2026-06-07T00",
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  const second = await controller.recordMeteredUsage("space_test", {
    installationId: "inst_fixture",
    kind: "backup_storage_gb_hour",
    quantity: 99,
    credits: 99,
    source: "resource_meter",
    idempotencyKey: "meter:inst_fixture:storage:2026-06-07T00",
    createdAt: "2026-06-07T00:30:00.000Z",
  });

  expect(second.usageEvent).toEqual(first.usageEvent);
  expect(await store.listUsageEvents("user_test")).toEqual([
    expect.objectContaining({
      workspaceId: "user_test",
      installationId: "inst_fixture",
      kind: "backup_storage_gb_hour",
      quantity: 12.5,
      credits: 3,
      source: "resource_meter",
      idempotencyKey: "meter:inst_fixture:storage:2026-06-07T00",
      resourceMetadata: expect.objectContaining({
        source_workspace_id: "space_test",
      }),
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
  await expect(
    controller.recordMeteredUsage("space_test", {
      kind: "gateway_compute",
      quantity: 1,
      usdMicros: 1_000,
      meterId: "cloudflare:workers_script:deploy",
      resourceFamily: "cloudflare.workers_script",
      source: "resource_meter",
      idempotencyKey: "operator:bad-metadata-key",
      resourceMetadata: {
        workers_for_platforms_backend: "true",
      },
    }),
  ).rejects.toThrow(
    "usage resourceMetadata must not expose an internal resource backend",
  );
  await expect(
    controller.recordMeteredUsage("space_test", {
      kind: "gateway_compute",
      quantity: 1,
      usdMicros: 1_000,
      meterId: "cloudflare:workers_script:deploy",
      resourceFamily: "cloudflare.workers_script",
      source: "resource_meter",
      idempotencyKey: "operator:bad-metadata-value",
      resourceMetadata: {
        backend: "workers_for_platforms",
      },
    }),
  ).rejects.toThrow(
    "usage resourceMetadata must not expose an internal resource backend",
  );
});

test("metered usage can atomically spend owner account USD balance when required", async () => {
  const { store, controller } = await seededController();
  await store.addCredits("user_test", {
    usdMicros: 1_000_000,
    updatedAt: "2026-06-07T00:00:00.000Z",
  });

  const first = await controller.recordMeteredUsage("space_test", {
    installationId: "inst_fixture",
    meterId: "cloudflare:workers_script:deploy",
    resourceFamily: "cloudflare.workers_script",
    resourceId: "script:api",
    operation: "deploy",
    kind: "gateway_compute",
    quantity: 1,
    usdMicros: 250_000,
    source: "resource_meter",
    spendRequired: true,
    idempotencyKey: "cloud-extension:/compat:space_test:deploy:1",
    createdAt: "2026-06-07T00:01:00.000Z",
  });
  const retry = await controller.recordMeteredUsage("space_test", {
    installationId: "inst_fixture",
    meterId: "cloudflare:workers_script:deploy",
    resourceFamily: "cloudflare.workers_script",
    resourceId: "script:api",
    operation: "deploy",
    kind: "gateway_compute",
    quantity: 1,
    usdMicros: 250_000,
    source: "resource_meter",
    spendRequired: true,
    idempotencyKey: "cloud-extension:/compat:space_test:deploy:1",
    createdAt: "2026-06-07T00:01:01.000Z",
  });

  expect(retry.usageEvent.id).toBe(first.usageEvent.id);
  expect(await store.listUsageEvents("user_test")).toHaveLength(1);
  expect(first.usageEvent).toMatchObject({
    workspaceId: "user_test",
    resourceMetadata: expect.objectContaining({
      source_workspace_id: "space_test",
    }),
  });
  expect(await store.getCreditBalance("user_test")).toMatchObject({
    availableUsdMicros: 750_000,
  });
});

test("owner account credits are shared across Workspaces owned by the same user", async () => {
  const { store, controller } = await seededController();
  const baseSpace = (await store.getSpace("space_test"))!;
  await store.putSpace({
    ...baseSpace,
    id: "space_second",
    handle: "second",
    displayName: "Second",
    ownerUserId: "user_test",
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });

  await controller.topUpSpaceCredits("space_test", {
    usdMicros: 1_000_000,
  });
  expect(await store.getCreditBalance("space_test")).toBeUndefined();
  expect(await store.getCreditBalance("user_test")).toMatchObject({
    availableUsdMicros: 1_000_000,
  });

  await controller.recordMeteredUsage("space_second", {
    meterId: "cloudflare:d1:create",
    resourceFamily: "cloudflare.d1",
    resourceId: "database:main",
    operation: "create",
    kind: "gateway_storage_gb_hour",
    quantity: 1,
    usdMicros: 250_000,
    source: "resource_meter",
    spendRequired: true,
    idempotencyKey: "cloud-extension:/compat:space_second:d1:create",
    createdAt: "2026-06-07T00:01:00.000Z",
  });

  expect(await store.getCreditBalance("user_test")).toMatchObject({
    availableUsdMicros: 750_000,
  });
  const { billing } = await controller.getSpaceBilling("space_second");
  expect(billing.balance).toMatchObject({
    workspaceId: "user_test",
    availableUsdMicros: 750_000,
  });
  const { usageEvents } = await controller.listSpaceUsage("space_second");
  expect(usageEvents).toEqual([
    expect.objectContaining({
      workspaceId: "user_test",
      resourceMetadata: expect.objectContaining({
        source_workspace_id: "space_second",
      }),
    }),
  ]);
});

test("metered usage spend fails closed without inserting usage on short balance", async () => {
  const { store, controller } = await seededController();
  await store.addCredits("user_test", {
    usdMicros: 100_000,
    updatedAt: "2026-06-07T00:00:00.000Z",
  });

  await expect(
    controller.recordMeteredUsage("space_test", {
      installationId: "inst_fixture",
      meterId: "cloudflare:workers_script:deploy",
      resourceFamily: "cloudflare.workers_script",
      resourceId: "script:api",
      operation: "deploy",
      kind: "gateway_compute",
      quantity: 1,
      usdMicros: 250_000,
      source: "resource_meter",
      spendRequired: true,
      idempotencyKey: "cloud-extension:/compat:space_test:deploy:short",
      createdAt: "2026-06-07T00:01:00.000Z",
    }),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: expect.objectContaining({ reason: "insufficient_credits" }),
  });
  expect(await store.listUsageEvents("user_test")).toHaveLength(0);
  expect(await store.getCreditBalance("user_test")).toMatchObject({
    availableUsdMicros: 100_000,
  });
});

test("invoice usage reconciliation records billing adjustment idempotently", async () => {
  const { store, controller } = await seededController();
  await store.putUsageEvent({
    id: "usage_runner",
    workspaceId: "user_test",
    spaceId: "user_test",
    installationId: "inst_fixture",
    runId: "apply_fixture",
    resourceMetadata: {
      source_workspace_id: "space_test",
    },
    kind: "runner_minute",
    quantity: 1.5,
    credits: 2,
    source: "runner",
    idempotencyKey: "apply_fixture:runner_minute",
    createdAt: "2026-06-07T00:10:00.000Z",
  });
  await controller.recordMeteredUsage("space_test", {
    installationId: "inst_fixture",
    kind: "egress_gb",
    quantity: 1,
    credits: 4,
    source: "resource_meter",
    idempotencyKey: "meter:inst_fixture:egress:2026-06-07T00",
    createdAt: "2026-06-07T00:15:00.000Z",
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
        "invoice-reconciliation:user_test:space_test:in_123:2026-06-07T00:00:00.000Z:2026-06-07T01:00:00.000Z",
    },
  });
  expect(
    (await store.listUsageEvents("user_test")).filter(
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
  // A destroy plan ALWAYS lands the PERSISTED `waiting_approval` status (spec
  // §19 two-stage destroy), independent of the environment's approval gate.
  expect(planRun.status).toEqual("waiting_approval");

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
    workspaceId: "space_test",
    capsuleId: "inst_fixture",
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

test("installation plan and apply record deploy operation metrics", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  const observability = new InMemoryObservabilitySink();
  await seedRunnableInstallationModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner, {
    observability,
    metricTags: {
      environment: "test",
      runtime_cell_id: "cell_test",
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  const operationMetrics = await observability.listMetrics({
    name: "takosumi_deploy_operation_count",
  });
  expect(operationMetrics.map((metric) => metric.tags)).toContainEqual({
    capsule_id: "inst_fixture",
    environment: "test",
    operationKind: "plan",
    runtime_cell_id: "cell_test",
    space_id: "space_test",
    status: "succeeded",
  });
  expect(operationMetrics.map((metric) => metric.tags)).toContainEqual({
    capsule_id: "inst_fixture",
    environment: "test",
    operationKind: "apply",
    runtime_cell_id: "cell_test",
    space_id: "space_test",
    status: "succeeded",
  });

  const applyDurations = await observability.listMetrics({
    name: "takosumi_apply_duration_seconds",
  });
  expect(applyDurations).toHaveLength(1);
  expect(applyDurations[0]?.kind).toBe("histogram");
  expect(applyDurations[0]?.tags).toMatchObject({
    capsule_id: "inst_fixture",
    operationKind: "apply",
    space_id: "space_test",
    status: "succeeded",
  });
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
  const { stableJsonDigest } =
    await import("../../../../core/adapters/source/digest.ts");
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

test("installation apply: a failing ledger commit leaves NO torn state (all-or-nothing)", async () => {
  // Regression guard for the atomic apply-commit (spec §20 / §21 / §16). Every
  // successful-apply ledger write — new Deployment, StateSnapshot, OutputSnapshot,
  // and the guarded Installation advance — is funneled through the single
  // `commitAppliedDeployment` store method. If that method fails (a crash /
  // error mid-write), the controller must NOT have persisted ANY of those
  // records: the run fails and the Installation stays at its pre-apply
  // generation. (The in-memory store cannot truly roll back without a
  // transaction, so the controller's guarantee is that the WHOLE atomic unit is
  // a single call which here throws before writing anything; the SQL/D1 backends
  // additionally roll back / batch — see store_model_test.ts.)
  const inner = new InMemoryOpenTofuDeploymentStore();
  const runner = recordingRunner();
  await seedRunnableInstallationModel(inner, { environment: "preview" });
  // Wrap the store so the atomic commit explodes; everything else delegates.
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "commitAppliedDeployment") {
        return () =>
          Promise.reject(
            new Error("injected: ledger commit crashed mid-write"),
          );
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as OpenTofuDeploymentStore;
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  expect(planRun.status).toBe("succeeded");

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  // The apply surfaces the failure rather than reporting a torn success.
  expect(applyRun.status).toBe("failed");

  // The ledger is intact: no Deployment, no new-generation StateSnapshot, no
  // OutputSnapshot, and the Installation is NOT advanced (still pending at gen 0
  // with no current deployment/output pointers).
  expect(await inner.listDeployments("inst_fixture")).toHaveLength(0);
  expect(
    await inner.getLatestStateSnapshot("inst_fixture", "preview"),
  ).toBeUndefined();
  expect(await inner.getLatestOutputSnapshot("inst_fixture")).toBeUndefined();
  const installation = await inner.getInstallation("inst_fixture");
  expect(installation?.status).toBe("pending");
  expect(installation?.currentStateGeneration).toBe(0);
  expect(installation?.currentDeploymentId).toBeUndefined();
  expect(installation?.currentOutputSnapshotId).toBeUndefined();
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

test("OutputSnapshot projection drops token-shaped allowlisted string outputs", async () => {
  const { store, controller } = await seededController({
    installConfig: {
      outputAllowlist: {
        status: { from: "public_status", type: "string" },
      },
    },
  });

  const { planRun } = await controller.createInstallationPlan("inst_fixture");
  const { deployment } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  const snapshot = await store.getOutputSnapshot(deployment!.outputSnapshotId!);
  expect(snapshot?.publicOutputs).not.toHaveProperty("status");
  expect(snapshot?.spaceOutputs).not.toHaveProperty("status");
  expect(deployment?.outputsPublic).not.toHaveProperty("status");
  expect(JSON.stringify(snapshot)).not.toContain("sk-output-raw-token");
  expect(JSON.stringify(deployment)).not.toContain("sk-output-raw-token");
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
    workspaceId: "space_test",
    capsuleId: "inst_fixture",
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
