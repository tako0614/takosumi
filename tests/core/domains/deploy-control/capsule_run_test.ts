/**
 * Capsule Run integration tests (Core Specification §19 / §20 / §21
 * / §23).
 *
 * The Workspace-direct model replaced the App/Environment/InstallProfile lanes: a
 * run targets an existing Capsule (seeded via `seedCapsuleModel`), and
 * the controller EMITS the dispatch fields the OpenTofu runner DO consumes.
 * These tests assert, via a recording runner, that an capsule-driven
 * plan/apply/destroy carries `stateScope { workspaceId, capsuleId, environment,
 * generation }` + `sourceArchive { ref, digest }` at the correct
 * generations, that a missing snapshot is a typed `source_sync_required` 409,
 * that a destroy-plan lands waiting_approval, that apply persists state at
 * base+1 and records a StateVersion + Output while marking the Capsule active
 * with a bumped generation, that destroy
 * (after approval) persists at base+1 and marks the Capsule destroyed, that
 * a second plan reads the bumped generation, and the security invariants: a
 * changed/missing SourceSnapshot at apply is failed_precondition and a stale
 * plan (generation moved) is state_generation_mismatch.
 */

import { expect, test } from "bun:test";
import type {
  OpenTofuApplyJob,
  OpenTofuDestroyJob,
  OpenTofuControllerDependencies,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRunner,
  ReleaseActivationInput,
} from "../../../../core/domains/deploy-control/mod.ts";
import {
  applyExpectedGuardFromPlanRun,
  DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
  OpenTofuControllerError,
  OpenTofuController,
  OpenTofuRunnerInfrastructureError,
} from "../../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  type AcquireCapsuleLeaseInput,
  type CapsuleCoordination,
  InMemoryCapsuleCoordination,
  type CapsuleLease,
  type ReleaseCapsuleLeaseInput,
  type RenewCapsuleLeaseInput,
} from "../../../../core/domains/deploy-control/capsule_lease.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import type { OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import {
  CredentialBundle,
  PhaseMintBundle,
} from "../../../../core/adapters/vault/mod.ts";
import { ActivityService } from "../../../../core/domains/activity/mod.ts";
import { InMemoryObservabilitySink } from "../../../../core/domains/observability/mod.ts";
import type {
  ProviderConnection,
  OpenTofuOutputEnvelope,
  PlanRun,
  PlanResourceChange,
  RunnerProfile,
} from "@takosumi/internal/deploy-control-api";
import {
  CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
  type InstallConfig,
  type InstallConfigLifecycleAction,
} from "takosumi-contract/install-configs";
import type {
  BillingEnforcement,
  ShowbackRater,
} from "takosumi-contract/billing";
import {
  FIXTURE_ARCHIVE_DIGEST,
  seedCapsuleModel,
  seedProviderConnections,
  type SeedCapsuleModelOptions,
} from "../../../helpers/deploy-control/model_fixture.ts";

const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const STATE_DIGEST =
  "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
// The fixture archives the snapshot under this object key (snapshotId snap_fixture).
const ARCHIVE_KEY =
  "workspaces/ws_test001/sources/src_fixture/snapshots/snap_fixture/source.tar.zst";
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
        // `launch_url` and `bucket_name` are ordinary non-sensitive Outputs
        // that flow to the public projection only when explicitly allowlisted.
        // `admin_token` is
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
  store: OpenTofuControlStore,
  runner: OpenTofuRunner,
  overrides: Partial<OpenTofuControllerDependencies> = {},
): OpenTofuController {
  return new OpenTofuController({
    store,
    runner,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
    ...overrides,
  });
}

class HangingRunnerProfileSeedStore extends InMemoryOpenTofuControlStore {
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

function observingCapsuleCoordination(now: () => number): {
  readonly coordination: CapsuleCoordination;
  readonly renewCalls: () => number;
} {
  const inner = new InMemoryCapsuleCoordination({ now });
  let renewCalls = 0;
  return {
    coordination: {
      acquireLease: (input: AcquireCapsuleLeaseInput) =>
        inner.acquireLease(input),
      releaseLease: (input: ReleaseCapsuleLeaseInput) =>
        inner.releaseLease(input),
      renewLease: (input: RenewCapsuleLeaseInput): Promise<CapsuleLease> => {
        renewCalls += 1;
        return inner.renewLease(input);
      },
    },
    renewCalls: () => renewCalls,
  };
}

async function waitForRenewedApplyHeartbeat(input: {
  readonly store: OpenTofuControlStore;
  readonly applyRunId: string;
  readonly initialHeartbeat: number;
  readonly renewCalls: () => number;
  readonly initialRenewCalls?: number;
}): Promise<number> {
  return await expectWithin(
    (async () => {
      while (true) {
        const heartbeat =
          (await input.store.getApplyRun(input.applyRunId))?.heartbeatAt ?? 0;
        if (
          heartbeat > input.initialHeartbeat &&
          input.renewCalls() > (input.initialRenewCalls ?? 0)
        ) {
          return heartbeat;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })(),
    1_000,
  );
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
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
    allowedProviders: providers,
    requireProviderBindings: true,
    stateBackend: { kind: "operator-managed", ref: "r2://state" },
    stateLock: { kind: "native" },
    networkPolicy: { mode: "operator-managed" },
    secretExposure: {
      providerCredentials: "runner-only",
      tenantWorkerOperatorSecrets: "forbidden",
      redactLogs: true,
      blockSensitiveOutputs: true,
    },
    createdAt: 1,
  };
}

function activityRecorderFor(store: OpenTofuControlStore): ActivityService {
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
  }) => ({
    provider: canonicalProviderForFixture(entry.provider),
    connectionId: entry.connectionId,
    temporary: true,
    ttlEnforced: true,
    phase: "plan" as const,
  });
  const envForEntry = (entry: {
    readonly provider: string;
    readonly connectionId: string;
  }) => {
    const shortName = providerShortNameForFixture(entry.provider);
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
              temporary: true,
              ttlEnforced: true,
              phase: "plan",
            },
          ],
        ),
      ),
    mintForCapsuleProviderBindings: (
      _workspaceId: string,
      entries: readonly { provider: string; connectionId: string }[] = [],
    ) => {
      const resolvedEntries =
        entries.length > 0
          ? entries
          : [
              {
                provider: "registry.opentofu.org/cloudflare/cloudflare",
                connectionId: "fixture",
              },
            ];
      const env = Object.assign({}, ...resolvedEntries.map(envForEntry));
      const evidence = resolvedEntries.map(evidenceForEntry);
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
  store: OpenTofuControlStore,
  conn: ProviderConnection,
): Promise<void> {
  if (!conn.workspaceId) {
    throw new Error(
      "putConnectionWithProviderEnv only seeds Workspace-scoped secret Provider Connections; global operator credentials must not become bindable Provider Connections",
    );
  }
  // After the credential-model collapse the connection IS the resolver record,
  // so enrich it with the required providerSource/materialization fields and
  // store the single unified row (no separate ProviderEnv).
  const connection: ProviderConnection = {
    ...conn,
    providerSource:
      conn.providerSource ?? canonicalProviderForFixture(conn.provider),
    materialization: conn.materialization ?? "secret",
    envNames: conn.envNames ?? [],
  };
  await store.putConnection(connection);
}

function cloudflareConnection(
  id: string,
  workspaceId = "ws_test001",
): ProviderConnection {
  return {
    id,
    workspaceId,
    scope: "workspace",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    kind: "cloudflare_api_token",
    materialization: "secret",
    status: "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  };
}

function cloudflareModuleInputDefaults(input: {
  readonly accountId: string;
  readonly providerBaseUrl?: string;
  readonly workersSubdomain?: string;
  readonly zoneId?: string;
}) {
  return {
    cloudflare_account_id: input.accountId,
    account_id: input.accountId,
    ...(input.providerBaseUrl
      ? { cloudflare_api_base_url: input.providerBaseUrl }
      : {}),
    ...(input.workersSubdomain
      ? {
          cloudflare_workers_subdomain: input.workersSubdomain,
          workersSubdomain: input.workersSubdomain,
        }
      : {}),
    ...(input.zoneId ? { cloudflare_route_zone_id: input.zoneId } : {}),
    cloudflare: {
      account_id: input.accountId,
      ...(input.providerBaseUrl ? { api_base_url: input.providerBaseUrl } : {}),
      ...(input.workersSubdomain
        ? { workers_subdomain: input.workersSubdomain }
        : {}),
    },
    enable_cloudflare_resources: true,
    enable_cloudflare_worker_script: true,
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
              temporary: true,
              ttlEnforced: true,
              phase: "plan" as const,
            },
          ],
        ),
      );
    },
    mintForCapsuleProviderBindings: () => {
      mintCount += 1;
      return Promise.resolve(
        new PhaseMintBundle(
          {
            env: {
              CLOUDFLARE_API_TOKEN: "fixture-provider-token",
            },
          },
          [],
          [
            {
              provider: "registry.opentofu.org/cloudflare/cloudflare",
              connectionId: "fixture",
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
 * Seeds the Workspace-direct Capsule model and returns a wired controller +
 * runner. Defaults to a `preview` environment so the no-approval apply path is
 * exercised; pass `environment: "production"` to land plans waiting_approval.
 */
async function seededController(
  options: SeedCapsuleModelOptions = {},
  controllerOverrides: Partial<OpenTofuControllerDependencies> = {},
): Promise<{
  store: OpenTofuControlStore;
  runner: RecordingRunner;
  controller: OpenTofuController;
}> {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    ...options,
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
    ...controllerOverrides,
  });
  return { store, runner, controller };
}

async function seedRunnableCapsuleModel(
  store: OpenTofuControlStore,
  options: SeedCapsuleModelOptions = {},
) {
  const seeded = await seedCapsuleModel(store, {
    workspaceId: options.workspaceId ?? "ws_test001",
    capsuleId: options.capsuleId ?? "cap_fixture1",
    ...options,
  });
  await seedProviderConnections(store, seeded.capsule);
  return seeded;
}

function lifecycleInstallConfig(
  actions: readonly Omit<
    InstallConfigLifecycleAction,
    "apiVersion" | "kind" | "runnerCapability"
  >[],
): Partial<InstallConfig> {
  const lifecycleActions: readonly InstallConfigLifecycleAction[] = actions.map(
    (action) => ({
      apiVersion: "takosumi.dev/v1alpha1",
      kind: "command",
      runnerCapability: CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
      ...action,
    }),
  );
  return {
    lifecycleActions,
    policy: {
      lifecycleActions: {
        allowedExecutors: [
          ...new Set(actions.map((action) => action.executor)),
        ],
        allowedRunnerCapabilities: [CAPSULE_LIFECYCLE_COMMAND_CAPABILITY],
        ...(actions.some((action) => action.useProviderCredentials === true)
          ? { allowProviderCredentials: true }
          : {}),
      },
    },
  };
}

test("an opaque app_deployment Output does not rebind provider credentials", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const appDeployment = {
    name: "takos-office",
    compute: {
      web: {
        kind: "worker",
        consume: [
          {
            publication: "storage.object",
            request: { scopes: ["files:read", "files:write"] },
            inject: {
              env: {
                url: "OBJECT_STORAGE_API_URL",
                token: "OBJECT_STORAGE_ACCESS_TOKEN",
              },
            },
          },
        ],
      },
    },
  } as const;
  const runner = recordingRunner({
    plannedOutputs: {
      app_deployment: { sensitive: false, value: appDeployment },
    },
  });
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: {
      outputAllowlist: {
        app_deployment: {
          from: "app_deployment",
          type: "json",
          required: true,
        },
      },
    },
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");

  expect(planRun.status).toBe("succeeded");
  expect(runner.planJobs).toHaveLength(1);
  const credentials = runner.planJobs[0]!.credentials;
  const env =
    credentials && "env" in credentials ? credentials.env : credentials;
  expect(env).not.toHaveProperty("TF_VAR_object_storage_api_url");
  expect(env).not.toHaveProperty("TF_VAR_object_storage_key_prefix");
  expect(env).not.toHaveProperty("TF_VAR_object_storage_access_token");
});

test("capsule plan dispatch carries sourceArchive + stateScope at the current generation", async () => {
  const { runner, controller } = await seededController();

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.sourceSnapshotId).toEqual("snap_fixture");
  expect(planRun.capsuleContext).toEqual({
    workspaceId: "ws_test001",
    capsuleId: "cap_fixture1",
    capsuleId: "cap_fixture1",
    environment: "preview",
  });
  // First plan: no prior StateVersion -> base generation 0.
  expect(planRun.baseStateGeneration).toEqual(0);

  expect(runner.planJobs).toHaveLength(1);
  const job = runner.planJobs[0]!;
  expect(job.sourceArchive).toEqual({
    ref: ARCHIVE_KEY,
    digest: FIXTURE_ARCHIVE_DIGEST,
  });
  // Plan restores against the CURRENT generation (0).
  expect(job.stateScope).toMatchObject({
    workspaceId: "ws_test001",
    environment: "preview",
    generation: 0,
    subject: { kind: "capsule", id: "cap_fixture1" },
  });
  expect(job.template).toBeUndefined();
  expect(job.generatedRoot?.files["main.tf"]).toContain('module "child"');
  expect(job.generatedRoot?.files["main.tf"]).toContain('source = "./module"');
  expect(job.generatedRoot?.files["versions.tf"]).toContain(
    "required_providers",
  );

  // The unified Run facade projects the capsule context.
  const run = await controller.getRun(planRun.id);
  expect(run.capsuleId).toEqual("cap_fixture1");
  expect(run.environment).toEqual("preview");
  expect(run.sourceSnapshotId).toEqual("snap_fixture");
  expect(run.baseStateGeneration).toEqual(0);
});

test("explicit source build is sealed with the plan and replayed for apply", async () => {
  const sourceBuild = {
    commands: [
      { argv: ["bun", "install", "--frozen-lockfile"] },
      {
        argv: ["bun", "run", "build"],
        workingDirectory: "web",
      },
    ],
    outputs: ["web/dist/index.js"],
  } as const;
  const { runner, controller } = await seededController({
    installConfig: { sourceBuild },
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  expect(planRun.status).toEqual("succeeded");
  expect(runner.planJobs[0]?.sourceBuild).toEqual(sourceBuild);

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun.status).toEqual("succeeded");
  expect(runner.applyJobs[0]?.sourceBuild).toEqual(sourceBuild);
});

test("capsule plan does not wait for runner profile seed persistence", async () => {
  const store = new HangingRunnerProfileSeedStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store);
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await expectWithin(
    controller.createCapsulePlan("cap_fixture1"),
    1_000,
  );

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.runnerProfileId).toEqual(profile.id);
  expect(runner.planJobs).toHaveLength(1);
});

test("capsule plan does not invent Cloudflare Capsule inputs from scope hints", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedCapsuleModel(store, {
    environment: "preview",
    installConfig: {
      variableMapping: { project_name: "takos" },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_scope",
      seeded.capsule.workspaceId,
    ),
    scopeHints: {
      accountId: "acct_scope_123",
      moduleInputDefaults: cloudflareModuleInputDefaults({
        accountId: "acct_scope_123",
      }),
    },
  });
  await store.putProviderBindingSet({
    id: "profile_cloudflare_scope",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
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

  const { planRun } = await controller.createCapsulePlan(seeded.capsule.id);

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
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedCapsuleModel(store, {
    environment: "preview",
    installConfig: {
      variableMapping: { project_name: "takos", cloudflare: {} },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_scope",
      seeded.capsule.workspaceId,
    ),
    scopeHints: {
      accountId: "acct_scope_123",
      moduleInputDefaults: cloudflareModuleInputDefaults({
        accountId: "acct_scope_123",
      }),
    },
  });
  await store.putProviderBindingSet({
    id: "profile_cloudflare_scope",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
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

  const { planRun } = await controller.createCapsulePlan(seeded.capsule.id);

  expect(planRun.status).toEqual("succeeded");
  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain('project_name = "takos"');
  expect(mainTf).toContain(
    'cloudflare = jsondecode("{\\"account_id\\":\\"acct_scope_123\\"}")',
  );
  expect(mainTf).not.toContain("fixture-provider-token");
});

test("dotted Cloudflare Capsule input merges with provider scope hints", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedCapsuleModel(store, {
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
      seeded.capsule.workspaceId,
    ),
    scopeHints: {
      accountId: "acct_scope_123",
      moduleInputDefaults: cloudflareModuleInputDefaults({
        accountId: "acct_scope_123",
      }),
    },
  });
  await store.putProviderBindingSet({
    id: "profile_cloudflare_scope",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
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

  const { planRun } = await controller.createCapsulePlan(seeded.capsule.id);

  expect(planRun.status).toEqual("succeeded");
  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain('\\"account_id\\":\\"acct_scope_123\\"');
  expect(mainTf).toContain('\\"workers_subdomain\\":\\"shoutatomiyama0614\\"');
  expect(mainTf).not.toContain("cloudflare.workers_subdomain");
  expect(mainTf).not.toContain("fixture-provider-token");
});

test("requested scalar Cloudflare Capsule inputs can be filled from provider scope hints", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedCapsuleModel(store, {
    environment: "preview",
    installConfig: {
      variableMapping: {
        cloudflare_account_id: null,
        account_id: null,
        cloudflare_api_base_url: null,
        cloudflare_workers_subdomain: null,
        workersSubdomain: null,
        enable_cloudflare_resources: null,
        enable_cloudflare_worker_script: null,
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
      seeded.capsule.workspaceId,
    ),
    scopeHints: {
      providerConfig: {
        base_url: "https://app.takosumi.com/compat/cloudflare/client/v4",
      },
      accountId: "acct_scope_123",
      workersSubdomain: "team-workers",
      moduleInputDefaults: cloudflareModuleInputDefaults({
        accountId: "acct_scope_123",
        providerBaseUrl: "https://app.takosumi.com/compat/cloudflare/client/v4",
        workersSubdomain: "team-workers",
      }),
    },
  });
  await store.putProviderBindingSet({
    id: "profile_cloudflare_scope",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
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

  const { planRun } = await controller.createCapsulePlan(seeded.capsule.id);

  expect(planRun.status).toEqual("succeeded");
  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain('cloudflare_account_id = "acct_scope_123"');
  expect(mainTf).toContain('account_id = "acct_scope_123"');
  expect(mainTf).toContain(
    'cloudflare_api_base_url = "https://app.takosumi.com/compat/cloudflare/client/v4"',
  );
  expect(mainTf).toContain('cloudflare_workers_subdomain = "team-workers"');
  expect(mainTf).toContain('workersSubdomain = "team-workers"');
  expect(mainTf).toContain("enable_cloudflare_resources = true");
  expect(mainTf).toContain("enable_cloudflare_worker_script = true");
  expect(mainTf).toContain(
    'cloudflare = jsondecode("{\\"account_id\\":\\"acct_scope_123\\",\\"api_base_url\\":\\"https://app.takosumi.com/compat/cloudflare/client/v4\\",\\"workers_subdomain\\":\\"team-workers\\"}")',
  );
  expect(mainTf).toContain("untouched = null");
  expect(mainTf).not.toContain("fixture-provider-token");
});

test("declared generic Capsule Cloudflare inputs and outputs are wired from source shape", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedCapsuleModel(store, {
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
      seeded.capsule.workspaceId,
    ),
    scopeHints: {
      accountId: "acct_scope_123",
      moduleInputDefaults: cloudflareModuleInputDefaults({
        accountId: "acct_scope_123",
      }),
    },
  });
  await store.putProviderBindingSet({
    id: "profile_cloudflare_scope",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
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

output "build_metadata" {
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

  const { planRun } = await controller.createCapsulePlan(seeded.capsule.id);

  expect(planRun.status).toEqual("succeeded");
  const root = runner.planJobs[0]!.generatedRoot!.files;
  expect(root["main.tf"]).toContain('project_name = "yuru-e2e"');
  expect(root["main.tf"]).toContain("enable_cloudflare_resources = true");
  expect(root["main.tf"]).toContain('cloudflare_account_id = "acct_scope_123"');
  expect(root["main.tf"]).not.toContain('\n  account_id = "acct_scope_123"');
  expect(root["outputs.tf"]).toContain('output "cloudflare_d1_database_id"');
  expect(root["outputs.tf"]).toContain('output "cloudflare_kv_namespace_id"');
  expect(root["outputs.tf"]!.match(/output "build_metadata"/g)).toHaveLength(1);
});

test("standard Git Capsule variables stay ordinary OpenTofu inputs", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedCapsuleModel(store, {
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
      seeded.capsule.workspaceId,
    ),
    scopeHints: { accountId: "acct_scope_123" },
  });
  await store.putProviderBindingSet({
    id: "profile_cloudflare_scope",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
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

  const { planRun } = await controller.createCapsulePlan(seeded.capsule.id);

  expect(planRun.status).toEqual("succeeded");
  const planJob = runner.planJobs[0]!;
  const mainTf = planJob.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain('image_ref = "registry.example.com/app@sha256:abc"');
  expect(mainTf).toContain('release_tag = "v1.2.3"');
  expect(mainTf).toContain('version = "1.2.3"');
});

test("app_url stays an ordinary OpenTofu input without publicEndpoint mapping", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedCapsuleModel(store, {
    environment: "preview",
    installConfig: {
      variableMapping: {
        app_url: "https://community.example.com",
        cloudflare: {
          account_id: null,
          api_base_url: null,
        },
      },
      store: {
        order: 100,
        surface: "service",
        kind: "worker",
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        suggestedName: "plain-app",
        badge: { ja: "追加候補", en: "Installable" },
        name: { ja: "Plain App", en: "Plain App" },
        description: { ja: "テスト", en: "Test" },
        inputs: [],
      },
    },
  });
  await putConnectionWithProviderEnv(store, {
    ...cloudflareConnection(
      "conn_cloudflare_managed_plain",
      seeded.capsule.workspaceId,
    ),
    scopeHints: {
      providerConfig: {
        base_url: "https://app.takosumi.com/compat/cloudflare/client/v4",
      },
      accountId: "ts_acc_takosumi_cloud",
    },
  });
  await store.putProviderBindingSet({
    id: "profile_cloudflare_managed_plain",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_managed_plain",
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

  const { planRun } = await controller.createCapsulePlan(seeded.capsule.id);

  expect(planRun.status).toEqual("succeeded");
  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain('app_url = "https://community.example.com"');
  await expect(
    store.getPublicHostReservation("community.example.com"),
  ).resolves.toBeUndefined();
});

test("generic Capsule setup variables are filtered to the declared OpenTofu module interface", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const releaseImages = {
    runtime: "registry.cloudflare.com/acc/takos-worker-runtime:0.10.0-abcdef",
    executor: "registry.cloudflare.com/acc/takos-agent:0.10.0-abcdef",
  };
  const seeded = await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: {
      variableMapping: {
        project_name: "takos-release",
        undeclared_runtime_options: releaseImages,
        takosumi_accounts_client_id: "toc_123",
        takosumi_accounts_issuer_url: "https://app.takosumi.com",
        takosumi_accounts_redirect_uri:
          "https://takos-release.app.takos.jp/auth/oidc/callback",
        takosumi_accounts_url: "https://app.takosumi.com",
        worker_name: "takos-release",
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
    rootModuleOutputs: [{ name: "url", sensitive: false, ephemeral: false }],
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createCapsulePlan(
    seeded.capsule.id,
    {},
    { compatibilityReportId: "caprep_no_release_images" },
  );

  expect(planRun.status).toEqual("succeeded");
  const planMainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(planMainTf).toContain('project_name = "takos-release"');
  expect(planMainTf).not.toContain("undeclared_runtime_options");
  expect(planMainTf).not.toContain("takos-worker-runtime:0.10.0-abcdef");
  expect(planMainTf).not.toContain("takos-agent:0.10.0-abcdef");
  expect(planMainTf).not.toContain("takosumi_accounts_client_id");
  expect(planMainTf).not.toContain("takosumi_accounts_issuer_url");
  expect(planMainTf).not.toContain("takosumi_accounts_redirect_uri");
  expect(planMainTf).not.toContain("takosumi_accounts_url");
  expect(planMainTf).not.toContain("worker_name");

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

test("generic Capsule with known empty module interface receives no setup variables", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: {
      variableMapping: {
        project_name: "takos-release",
        undeclared_runtime_options: {
          runtime:
            "registry.cloudflare.com/acc/takos-worker-runtime:0.10.0-abcdef",
        },
        takosumi_accounts_client_id: "toc_123",
        takosumi_accounts_issuer_url: "https://app.takosumi.com",
        takosumi_accounts_redirect_uri:
          "https://takos-release.app.takos.jp/auth/oidc/callback",
        takosumi_accounts_url: "https://app.takosumi.com",
        worker_name: "takos-release",
      },
    },
  });
  await store.putCapsuleCompatibilityReport({
    id: "caprep_no_inputs",
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
    rootModuleVariables: [],
    rootModuleOutputs: [],
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createCapsulePlan(
    seeded.capsule.id,
    {},
    { compatibilityReportId: "caprep_no_inputs" },
  );

  expect(planRun.status).toEqual("succeeded");
  const planMainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(planMainTf).toContain('module "child"');
  expect(planMainTf).not.toContain("project_name");
  expect(planMainTf).not.toContain("undeclared_runtime_options");
  expect(planMainTf).not.toContain("takosumi_accounts_client_id");
  expect(planMainTf).not.toContain("takosumi_accounts_issuer_url");
  expect(planMainTf).not.toContain("takosumi_accounts_redirect_uri");
  expect(planMainTf).not.toContain("takosumi_accounts_url");
  expect(planMainTf).not.toContain("worker_name");
});

test("explicit Cloudflare Capsule variables override provider scope hint defaults", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedCapsuleModel(store, {
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
      seeded.capsule.workspaceId,
    ),
    scopeHints: { accountId: "acct_scope_123" },
  });
  await store.putProviderBindingSet({
    id: "profile_cloudflare_scope",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "main",
        connectionId: "conn_cloudflare_scope",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createCapsulePlan(seeded.capsule.id);

  expect(planRun.status).toEqual("succeeded");
  const mainTf = runner.planJobs[0]!.generatedRoot!.files["main.tf"]!;
  expect(mainTf).toContain('\\"account_id\\":\\"acct_explicit_456\\"');
  expect(mainTf).toContain('\\"zone_id\\":\\"zone_789\\"');
  expect(mainTf).not.toContain("acct_scope_123");
  expect(mainTf).not.toContain("fixture-provider-token");
});

test("capsule plan treats sourceArchive as the selected module subtree", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
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

  const { planRun } = await controller.createCapsulePlan(seeded.capsule.id);

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
    ref: ARCHIVE_KEY,
    digest: FIXTURE_ARCHIVE_DIGEST,
  });
  expect("modulePath" in runner.planJobs[0]!.planRun.source).toBe(false);
});

test("capsule plan resolves the latest SourceSnapshot for the Source ref and path", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
    environment: "preview",
  });
  const modulePath = "deploy/opentofu";
  const selectedArchiveKey =
    "workspaces/ws_test001/sources/src_fixture/snapshots/snap_module_path/source.tar.zst";
  await store.putSource({
    ...seeded.source,
    defaultPath: modulePath,
  });
  await store.putSourceSnapshot({
    ...seeded.snapshot,
    id: "snap_module_path",
    path: modulePath,
    archiveRef: selectedArchiveKey,
    fetchedByRunId: "run_module_path_sync",
    fetchedAt: "2026-06-06T00:00:01.000Z",
  });
  await store.putSourceSnapshot({
    ...seeded.snapshot,
    id: "snap_wrong_path_newer",
    path: ".",
    archiveRef:
      "workspaces/ws_test001/sources/src_fixture/snapshots/snap_wrong_path_newer/source.tar.zst",
    fetchedByRunId: "run_wrong_path_sync",
    fetchedAt: "2026-06-06T00:00:02.000Z",
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createCapsulePlan(seeded.capsule.id);

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.sourceSnapshotId).toEqual("snap_module_path");
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]?.sourceArchive).toEqual({
    ref: selectedArchiveKey,
    digest: FIXTURE_ARCHIVE_DIGEST,
  });
});

test("capsule destroy-plan pins the active StateVersion source snapshot instead of the latest Git snapshot", async () => {
  const { store, runner, controller } = await seededController();

  const create = await controller.createCapsulePlan("cap_fixture1");
  const created = await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });
  expect(created.capsule?.currentStateVersionId).toBeDefined();

  const newerArchiveKey =
    "workspaces/ws_test001/sources/src_fixture/snapshots/snap_newer_after_apply/source.tar.zst";
  await store.putSourceSnapshot({
    id: "snap_newer_after_apply",
    origin: "git",
    workspaceId: "ws_test001",
    sourceId: "src_fixture",
    url: "https://git.example.com/example/app.git",
    ref: "main",
    resolvedCommit: "bbbbbb0123456789abcdef0123456789abcdef01",
    path: ".",
    archiveRef: newerArchiveKey,
    archiveDigest: FIXTURE_ARCHIVE_DIGEST,
    archiveSizeBytes: 1024,
    fetchedByRunId: "run_newer_after_apply_sync",
    fetchedAt: "2026-06-06T00:00:10.000Z",
  });

  const destroy = await controller.createCapsuleDestroyPlan("cap_fixture1");

  expect(destroy.planRun.operation).toEqual("destroy");
  expect(destroy.planRun.sourceSnapshotId).toEqual("snap_fixture");
  expect(destroy.planRun.status).toEqual("waiting_approval");
  expect(runner.planJobs).toHaveLength(2);
  expect(runner.planJobs[1]?.sourceArchive).toEqual({
    ref: ARCHIVE_KEY,
    digest: FIXTURE_ARCHIVE_DIGEST,
  });
  expect(runner.planJobs[1]?.sourceArchive?.ref).not.toEqual(newerArchiveKey);
});

test("capsule plan uses InstallConfig modulePath inside a repo-root SourceSnapshot", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: {
      modulePath: "deploy/opentofu",
    },
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createCapsulePlan(seeded.capsule.id);

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.source.kind).toEqual("git");
  expect(planRun.source).toHaveProperty("modulePath", "deploy/opentofu");
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]!.planRun.source).toHaveProperty(
    "modulePath",
    "deploy/opentofu",
  );
});

test("capsule queued plan reconstructs dispatch when generated-root sidecar is missing", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
    environment: "preview",
  });
  await putConnectionWithProviderEnv(store, {
    id: "conn_missing_sidecar",
    scope: "workspace",
    workspaceId: seeded.capsule.workspaceId,
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    kind: "cloudflare_api_token",
    displayName: "Missing sidecar Cloudflare",
    status: "verified",
    scopeJson: {},
    now: sequenceNow(1),
    newId: deterministicIds(),
  });
  await store.putProviderBindingSet({
    id: "profile_missing_sidecar",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "main",
        connectionId: "conn_missing_sidecar",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const counted = countingProviderVault();
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    runner,
    vault: counted.vault as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
    enqueueRun: () => Promise.resolve(),
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  expect(planRun.status).toBe("queued");
  expect(await store.getPlanRunInputs(planRun.id)).toBeDefined();

  await store.deletePlanRunInputs(planRun.id);
  const completed = await controller.runQueuedPlan(planRun.id);

  expect(completed?.status).toBe("succeeded");
  expect(counted.mintCount).toBeGreaterThan(0);
  expect(runner.planJobs).toHaveLength(1);
});

test("capsule plan verifies CompatibilityReport before provider credential mint", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
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
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putCapsule({
    ...seeded.capsule,
    compatibilityReportId: "caprep_needs_patch",
    compatibilityStatus: "needs_patch",
  });
  const controller = controllerWith(store, runner);

  await expect(controller.createCapsulePlan("cap_fixture1")).rejects.toThrow(
    "compatibility_report_not_runnable",
  );
  expect(runner.planJobs).toHaveLength(0);
});

test("capsule CompatibilityReport gate honors InstallConfig resource policy", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
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
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putCapsule({
    ...seeded.capsule,
    compatibilityReportId: "caprep_policy_allowed_resource",
    compatibilityStatus: "unsupported",
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");

  expect(planRun.status).toEqual("succeeded");
  expect(runner.planJobs).toHaveLength(1);
  expect(planRun.policy.reasons.join("\n")).not.toContain(
    "compatibility_report_not_runnable",
  );
});

test("capsule plan creates and pins a CompatibilityReport when SourcesService is wired", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, {
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
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    runner,
    sourcesService,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");

  expect(planRun.status).toBe("succeeded");
  expect(planRun.compatibilityReportId).toBe("caprep_compat_auto");
  const capsule = await store.getCapsule("cap_fixture1");
  expect(capsule?.compatibilityReportId).toBe("caprep_compat_auto");
  expect(capsule?.compatibilityStatus).toBe("ready");
  expect(sourceFileReadOptions).toEqual([
    {
      modulePath: "deploy/opentofu",
      runId: "ccr_compat_auto",
    },
  ]);
  expect(runner.planJobs).toHaveLength(1);
});

test("capsule plan reuses a preflight CompatibilityReport hint without rechecking source files", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
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
      seeded.capsule.workspaceId,
    ),
    scopeHints: {
      accountId: "acct_scope_123",
      workersSubdomain: "team-workers",
      moduleInputDefaults: cloudflareModuleInputDefaults({
        accountId: "acct_scope_123",
        workersSubdomain: "team-workers",
      }),
    },
  });
  await store.putProviderBindingSet({
    id: "profile_cloudflare_scope",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
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
    rootModuleOutputs: [
      { name: "worker_name", sensitive: false, ephemeral: false },
      { name: "url", sensitive: false, ephemeral: false },
    ],
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
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    runner,
    sourcesService,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createCapsulePlan(
    "cap_fixture1",
    {},
    { compatibilityReportId: "caprep_preflight" },
  );

  expect(planRun.status).toBe("succeeded");
  expect(planRun.compatibilityReportId).toBe("caprep_preflight");
  const capsule = await store.getCapsule("cap_fixture1");
  expect(capsule?.compatibilityReportId).toBe("caprep_preflight");
  expect(capsule?.compatibilityStatus).toBe("ready");
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
  expect(outputsTf).toContain('output "worker_name"');
});

test("capsule plan reuses the latest matching preflight CompatibilityReport when the client omits the hint", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
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
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    runner,
    sourcesService,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1", {});

  expect(planRun.status).toBe("succeeded");
  expect(planRun.compatibilityReportId).toBe("caprep_preflight");
  const capsule = await store.getCapsule("cap_fixture1");
  expect(capsule?.compatibilityReportId).toBe("caprep_preflight");
  expect(capsule?.compatibilityStatus).toBe("ready");
  expect(sourceFileReadCount).toBe(1);
  expect(runner.planJobs).toHaveLength(1);
});

test("capsule plan ignores a stale cached CompatibilityReport when a matching preflight report exists", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
    environment: "preview",
  });
  await store.putCapsuleCompatibilityReport({
    id: "caprep_stale_cached",
    sourceId: seeded.source.id,
    capsuleId: seeded.capsule.id,
    sourceSnapshotId: "snap_old",
    level: "ready",
    findings: [],
    providers: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putCapsule({
    ...seeded.capsule,
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
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    runner,
    sourcesService,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1", {});

  expect(planRun.status).toBe("succeeded");
  expect(planRun.compatibilityReportId).toBe("caprep_current_preflight");
  const capsule = await store.getCapsule("cap_fixture1");
  expect(capsule?.compatibilityReportId).toBe("caprep_current_preflight");
  expect(runner.planJobs).toHaveLength(1);
});

test("failed compatibility analysis does not replace the Capsule current report", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
    environment: "preview",
  });
  await store.putCapsuleCompatibilityReport({
    id: "caprep_previous",
    sourceId: seeded.source.id,
    capsuleId: seeded.capsule.id,
    sourceSnapshotId: "snap_previous",
    level: "ready",
    findings: [],
    providers: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: "2026-06-06T00:00:00.000Z",
  });
  await store.putCapsule({
    ...seeded.capsule,
    compatibilityReportId: "caprep_previous",
    compatibilityStatus: "ready",
  });
  const sourcesService = new SourcesService({
    store,
    now: () => new Date("2026-06-07T00:00:00.000Z"),
    newId: (prefix) => `${prefix}_failed_check`,
    readCapsuleSourceFiles: () => {
      throw new Error("compatibility runner unavailable");
    },
  });
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    runner,
    sourcesService,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  await expect(
    controller.createCapsulePlan(seeded.capsule.id),
  ).rejects.toThrow();

  const capsule = await store.getCapsule(seeded.capsule.id);
  expect(capsule?.compatibilityReportId).toBe("caprep_previous");
  expect(capsule?.compatibilityStatus).toBe("ready");
  expect(runner.planJobs).toHaveLength(0);
});

test("capsule plan dispatches the original source archive without a rewritten module artifact", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, { environment: "preview" });
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
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    runner,
    sourcesService,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");

  expect(planRun.status).toBe("succeeded");
  expect(planRun.compatibilityReportId).toBe("caprep_compat_auto");
  const report =
    await store.getCapsuleCompatibilityReport("caprep_compat_auto");
  expect(report?.level).toBe("ready");
  expect(report).not.toHaveProperty("normalizedObjectKey");
  expect(report).not.toHaveProperty("normalizedDigest");
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]?.sourceArchive).toEqual({
    ref: ARCHIVE_KEY,
    digest: FIXTURE_ARCHIVE_DIGEST,
  });
  const moduleFiles = runner.planJobs[0]?.generatedRoot?.moduleFiles;
  expect(moduleFiles).toBeUndefined();
});

test("capsule plan records runnable CompatibilityReport in policy audit", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
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
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putCapsule({
    ...seeded.capsule,
    compatibilityReportId: "caprep_ready",
    compatibilityStatus: "ready",
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");

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

test("generic Capsule capsule plan derives pre-init requiredProviders from CompatibilityReport providers", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const awsProvider = "registry.opentofu.org/hashicorp/aws";
  const runner = recordingRunner({
    requiredProviders: [awsProvider],
    providerInstallation: [
      {
        provider: awsProvider,
        mirrored: false,
        installationMethod: "direct",
        attested: false,
      },
    ],
  });
  const seeded = await seedRunnableCapsuleModel(store, {
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
        source: awsProvider,
        aliases: [],
        allowed: true,
      },
    ],
    resources: [],
    dataSources: [],
    provisioners: [],
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putCapsule({
    ...seeded.capsule,
    compatibilityReportId: "caprep_providers",
    compatibilityStatus: "ready",
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");

  expect(planRun.requiredProviders).toEqual([awsProvider]);
  expect(runner.planJobs[0]?.planRun.requiredProviders).toEqual([awsProvider]);
});

test("generic OpenTofu runner profile derives pre-init requiredProviders from ProviderBinding before dispatch", async () => {
  const provider = "registry.opentofu.org/vercel/vercel";
  const store = new InMemoryOpenTofuControlStore();
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
  const seeded = await seedRunnableCapsuleModel(store, {
    environment: "preview",
  });
  await putConnectionWithProviderEnv(store, {
    id: "conn_vercel",
    workspaceId: seeded.capsule.workspaceId,
    provider,
    kind: "generic_env_provider",
    scope: "workspace",
    status: "verified",
    envNames: ["VERCEL_API_TOKEN"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    verifiedAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putProviderBindingSet({
    id: "profile_vercel",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
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
    id: "opentofu-default",
    name: "Generic OpenTofu provider",
    substrate: "cloudflare-containers",
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
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

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");

  expect(runner.planJobs[0]?.planRun.requiredProviders).toEqual([provider]);
  expect(planRun.requiredProviders).toEqual([provider]);
  expect(planRun.policy.status).toEqual("passed");
});

test("generic OpenTofu runner profile permits direct provider install by default", async () => {
  const provider = "registry.opentofu.org/vercel/vercel";
  const store = new InMemoryOpenTofuControlStore();
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
  const seeded = await seedRunnableCapsuleModel(store, {
    environment: "preview",
  });
  await putConnectionWithProviderEnv(store, {
    id: "conn_vercel_direct_profile",
    workspaceId: seeded.capsule.workspaceId,
    provider,
    kind: "generic_env_provider",
    scope: "workspace",
    status: "verified",
    envNames: ["VERCEL_API_TOKEN"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    verifiedAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putProviderBindingSet({
    id: "profile_vercel_direct_profile",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
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
    id: "opentofu-default",
    name: "Generic OpenTofu provider",
    substrate: "cloudflare-containers",
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
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

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");

  expect(runner.planJobs[0]?.providerInstallationPolicy).toBeUndefined();
  expect(planRun.status).toEqual("succeeded");
  expect(planRun.policy.status).toEqual("passed");
});

test("generic Capsule plan allows provider-free modules without ProviderConnection", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner({
    requiredProviders: [],
    providerInstallation: [],
  });
  const seeded = await seedCapsuleModel(store, {
    workspaceId: "ws_test001",
    capsuleId: "cap_fixture1",
    environment: "preview",
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createCapsulePlan(seeded.capsule.id);

  expect(planRun.status).toBe("succeeded");
  expect(planRun.requiredProviders).toEqual([]);
  expect(planRun.policy.status).toBe("passed");
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]?.planRun.requiredProviders).toEqual([]);
});

test("low-level plan does not infer requiredProviders from ProviderBinding alone", async () => {
  const provider = "registry.opentofu.org/vercel/vercel";
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
    environment: "preview",
  });
  await putConnectionWithProviderEnv(store, {
    id: "conn_vercel_direct",
    workspaceId: seeded.capsule.workspaceId,
    provider,
    kind: "generic_env_provider",
    scope: "workspace",
    status: "verified",
    envNames: ["VERCEL_API_TOKEN"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    verifiedAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putProviderBindingSet({
    id: "profile_vercel_direct",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
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
    id: "opentofu-default",
    name: "Generic OpenTofu provider",
    substrate: "cloudflare-containers",
    executorId: DEFAULT_OPENTOFU_RUNNER_EXECUTOR_ID,
    lifecycle: { state: "active" },
    availability: { state: "available" },
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
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    source: {
      kind: "git",
      url: seeded.source.url,
      ref: seeded.source.defaultRef,
      modulePath: seeded.source.defaultPath,
    },
    runnerProfileId: genericProfile.id,
    requiredProviders: [],
  });

  expect(planRun.status).toEqual("succeeded");
  expect(planRun.policy.status).toEqual("passed");
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]?.requiredProviders).toBeUndefined();
});

test("generic Capsule plan creation blocks stale CompatibilityReport as policy", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
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
  await store.putCapsule({
    ...seeded.capsule,
    compatibilityReportId: "caprep_stale",
    compatibilityStatus: "ready",
  });
  const controller = controllerWith(store, runner);

  await expect(controller.createCapsulePlan(seeded.capsule.id)).rejects.toThrow(
    "compatibility_report_snapshot_mismatch",
  );
  expect(runner.planJobs).toHaveLength(0);
});

test("capsule apply revalidates CompatibilityReport before provider credential mint", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
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
    createdAt: "2026-06-07T00:00:00.000Z",
  };
  await store.putCapsuleCompatibilityReport(report);
  await store.putCapsule({
    ...seeded.capsule,
    compatibilityReportId: report.id,
    compatibilityStatus: "ready",
  });
  await putConnectionWithProviderEnv(store, {
    id: "conn_apply_guard",
    scope: "workspace",
    workspaceId: seeded.capsule.workspaceId,
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    kind: "cloudflare_api_token",
    displayName: "Apply guard Cloudflare",
    status: "verified",
    scopeJson: {},
    secretRef: "sec_apply_guard",
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putProviderBindingSet({
    id: "profile_apply_guard",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "main",
        connectionId: "conn_apply_guard",
      },
    ],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  const counted = countingProviderVault();
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    runner,
    vault: counted.vault as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
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

test("capsule apply rejects a CompatibilityReport scoped to another Capsule before credential mint", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
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
    createdAt: "2026-06-07T00:00:00.000Z",
  };
  await store.putCapsuleCompatibilityReport(report);
  await store.putCapsule({
    ...seeded.capsule,
    compatibilityReportId: report.id,
    compatibilityStatus: "ready",
  });
  await putConnectionWithProviderEnv(store, {
    id: "conn_apply_scope_guard",
    scope: "workspace",
    workspaceId: seeded.capsule.workspaceId,
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    kind: "cloudflare_api_token",
    displayName: "Apply scope guard Cloudflare",
    status: "verified",
    scopeJson: {},
    secretRef: "sec_apply_scope_guard",
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  await store.putProviderBindingSet({
    id: "profile_apply_scope_guard",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "main",
        connectionId: "conn_apply_scope_guard",
      },
    ],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  const counted = countingProviderVault();
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    runner,
    vault: counted.vault as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const mintCountAfterPlan = counted.mintCount;
  await store.putCapsuleCompatibilityReport({
    ...report,
    capsuleId: "inst_other",
  });

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(applyRun.diagnostics?.[0]?.message).toContain(
    "compatibility_report_capsule_mismatch",
  );
  expect(counted.mintCount).toBe(mintCountAfterPlan);
  expect(runner.applyJobs).toHaveLength(0);
});

test("capsule apply reconstructs dispatch when generated-root sidecar is missing", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
    environment: "preview",
  });
  await putConnectionWithProviderEnv(store, {
    id: "conn_apply_missing_sidecar",
    scope: "workspace",
    workspaceId: seeded.capsule.workspaceId,
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    kind: "cloudflare_api_token",
    displayName: "Apply missing sidecar Cloudflare",
    status: "verified",
    scopeJson: {},
    now: sequenceNow(1),
    newId: deterministicIds(),
  });
  await store.putProviderBindingSet({
    id: "profile_apply_missing_sidecar",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "main",
        connectionId: "conn_apply_missing_sidecar",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  const counted = countingProviderVault();
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    runner,
    vault: counted.vault as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  expect(planRun.status).toBe("succeeded");
  const mintCountAfterPlan = counted.mintCount;
  expect(mintCountAfterPlan).toBeGreaterThan(0);

  await store.deletePlanRunInputs(planRun.id);
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect(counted.mintCount).toBeGreaterThan(mintCountAfterPlan);
  expect(runner.applyJobs).toHaveLength(1);
});

test("capsule plan blocks when provider lockfile digest is required but missing", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner({ providerLockDigest: undefined });
  await seedRunnableCapsuleModel(store, {
    installConfig: {
      policy: {
        providerLockfile: { requireDigest: true },
      },
    },
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");

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

test("capsule plan blocks when provider mirror evidence is required but missing", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner({ providerInstallation: undefined });
  const seeded = await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: {
      policy: {
        providerInstallation: { requireMirror: true },
      },
    },
  });
  await seedProviderConnections(store, seeded.capsule, {
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

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");

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

test("capsule plan permits direct provider installation by default", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner({
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    providerInstallation: undefined,
  });
  await seedRunnableCapsuleModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");

  expect(runner.planJobs[0]?.providerInstallationPolicy).toBeUndefined();
  expect(planRun.status).toBe("succeeded");
  expect(planRun.policy.reasons).toEqual([]);
});

test("capsule plan enforces filesystem mirror evidence for every required provider", async () => {
  const store = new InMemoryOpenTofuControlStore();
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
  const seeded = await seedRunnableCapsuleModel(store, {
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
  await seedProviderConnections(store, seeded.capsule, {
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

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");

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

test("capsule plan blocks when mirror evidence omits a required provider", async () => {
  const store = new InMemoryOpenTofuControlStore();
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
  const seeded = await seedRunnableCapsuleModel(store, {
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
  await seedProviderConnections(store, seeded.capsule, {
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

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");

  expect(planRun.status).toBe("failed");
  expect(planRun.policy.reasons.join("\n")).toContain(
    "provider installation attestation is missing for required providers: registry.opentofu.org/hashicorp/aws",
  );
});

test("capsule plan blocks when mirror evidence is not actual install attestation", async () => {
  const store = new InMemoryOpenTofuControlStore();
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
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: {
      policy: {
        allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
        providerInstallation: { requireMirror: true },
      },
    },
  });
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");

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

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
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

test("service-side lifecycle action receives only non-sensitive OpenTofu outputs", async () => {
  const store = new InMemoryOpenTofuControlStore();
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
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "activate",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "run", "app:activate"],
      },
    ]),
  });
  const boundConnection = await store.getConnection(
    "conn_fixture_ws_test001_cloudflare",
  );
  expect(boundConnection).toBeDefined();
  await store.putConnection({
    ...boundConnection!,
    scopeHints: {
      ...boundConnection!.scopeHints,
      providerConfig: {
        base_url: "https://provider.example.test/api",
      },
    },
  });
  const activations: ReleaseActivationInput[] = [];
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: (input) => {
        activations.push(input);
        return Promise.resolve({
          status: "pending",
          kind: "operator.release",
          metadata: { artifactName: "preview" },
        });
      },
    },
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun, capsule } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(applyRun.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "capsule_lifecycle_action_failed",
      severity: "error",
    }),
  );
  expect(capsule?.status).toBe("error");
  expect(applyRun.stateVersionId).toBeDefined();
  expect(applyRun.outputId).toBeDefined();
  expect(await store.getStateVersion(applyRun.stateVersionId!)).toBeDefined();
  expect(await store.getOutput(applyRun.outputId!)).toBeDefined();
  expect(activations).toHaveLength(1);
  expect(activations[0]?.nonSensitiveOutputs).toEqual({
    launch_url: "https://yuru-smoke-secret.example",
    public_url: "https://public.example",
    worker_name: "yuru-smoke-secret",
    bucket_name: "my-bucket",
  });
  expect(activations[0]?.providerConfigurations).toEqual({
    format: "takosumi.provider-configurations@v1",
    providers: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "main",
        configuration: {
          base_url: "https://provider.example.test/api",
        },
      },
    ],
  });
  expect(activations[0]?.credentials).toBeUndefined();
  expect(JSON.stringify(activations[0])).not.toContain("admin_token");
  expect(JSON.stringify(activations[0])).not.toContain("super-secret-token");
  expect(JSON.stringify(activations[0])).not.toContain("sk-output-raw-token");

  const activity = (await store.listActivityEvents("ws_test001")).find(
    (event) =>
      event.action === "release_activation.failed" &&
      event.metadata.activationKind === "operator.release",
  );
  expect(activity).toBeDefined();
  expect(activity).toMatchObject({
    targetType: "state_version",
    targetId: applyRun.stateVersionId,
    runId: applyRun.id,
    metadata: {
      capsuleId: "cap_fixture1",
      applyRunId: applyRun.id,
      stateVersionId: applyRun.stateVersionId,
      outputCount: 4,
      activationKind: "operator.release",
      hasHealthUrl: false,
      metadataKeys: ["artifactName"],
    },
  });
  expect(JSON.stringify(activity)).not.toContain(
    "https://yuru-smoke-secret.example",
  );
  expect(JSON.stringify(activity)).not.toContain("super-secret-token");
});

test("release activator receives service-side post-apply actions as opaque argv", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner(
    {},
    {
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "activate",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "run", "app:activate", "--target", "runtime"],
        workingDirectory: ".",
        timeoutSeconds: 900,
        env: { APP_RELEASE_TARGET: "runtime" },
      },
    ]),
  });
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

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
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
  const activities = await store.listActivityEvents("ws_test001");
  const pendingActivity = activities.find(
    (event) => event.action === "release_activation.pending",
  );
  expect(pendingActivity?.metadata).toMatchObject({
    activationKind: "takosumi.install-config-actions@v1",
    commandCount: 1,
    message: "post-apply lifecycle actions are running",
  });
  const activity = activities.find(
    (event) => event.action === "release_activation.succeeded",
  );
  expect(activity?.metadata).toMatchObject({
    commandCount: 1,
  });
});

test("lifecycle action plan fails when the selected RunnerProfile lacks its declared capability", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "publish",
        phase: "post_apply",
        executor: "runner",
        command: ["bun", "run", "publish"],
      },
    ]),
  });
  const profile = { ...multiProviderRunnerProfile(), capabilities: [] };
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  await expect(
    controller.createCapsulePlan("cap_fixture1"),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    message: expect.stringContaining("unavailable runner capability"),
  });
  expect(runner.planJobs).toHaveLength(0);
});

test("runner lifecycle actions reject mixed provider credential opt-in within one phase", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "with-provider-credentials",
        phase: "post_apply",
        executor: "runner",
        command: ["bun", "run", "publish"],
        useProviderCredentials: true,
      },
      {
        id: "without-provider-credentials",
        phase: "post_apply",
        executor: "runner",
        command: ["bun", "run", "verify"],
      },
    ]),
  });
  const profile = {
    ...multiProviderRunnerProfile(),
    capabilities: [CAPSULE_LIFECYCLE_COMMAND_CAPABILITY],
  };
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  await expect(
    controller.createCapsulePlan("cap_fixture1"),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    message: expect.stringContaining(
      "must all opt in to provider credentials or all run without them",
    ),
  });
  expect(runner.planJobs).toHaveLength(0);
});

test("apply fails closed when a pinned runner lifecycle capability was revoked after plan", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "publish",
        phase: "post_apply",
        executor: "runner",
        command: ["bun", "run", "publish"],
      },
    ]),
  });
  const capableProfile = {
    ...multiProviderRunnerProfile(),
    capabilities: [CAPSULE_LIFECYCLE_COMMAND_CAPABILITY],
  };
  const planningController = controllerWith(store, runner, {
    runnerProfiles: [capableProfile],
    defaultRunnerProfileId: capableProfile.id,
  });
  const { planRun } =
    await planningController.createCapsulePlan("cap_fixture1");

  const applyController = controllerWith(store, runner, {
    runnerProfiles: [{ ...capableProfile, capabilities: [] }],
    defaultRunnerProfileId: capableProfile.id,
  });
  const { applyRun } = await applyController.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(applyRun.diagnostics).toContainEqual(
    expect.objectContaining({
      message: expect.stringContaining("unavailable runner capability"),
    }),
  );
  expect(runner.applyJobs).toHaveLength(0);
});

test("operator lifecycle actions use operator authority instead of RunnerProfile capability", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "publish",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "run", "publish"],
      },
    ]),
  });
  const profile = { ...multiProviderRunnerProfile(), capabilities: [] };
  const activations: ReleaseActivationInput[] = [];
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
    releaseActivator: {
      activate: (input) => {
        activations.push(input);
        return Promise.resolve({ status: "succeeded" });
      },
    },
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(planRun.status).toBe("succeeded");
  expect(applyRun.status).toBe("succeeded");
  expect(activations).toHaveLength(1);
  expect(activations[0]?.commands[0]?.executor).toBe("operator");
});

test("post-apply lifecycle Activity does not stay pending when ledger commit conflicts", async () => {
  const inner = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(inner, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "publish",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "run", "publish"],
      },
    ]),
  });
  const store = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "commitRunState") {
        return () => Promise.reject(new Error("injected ledger conflict"));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as OpenTofuControlStore;
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: () => Promise.resolve({ status: "succeeded" }),
    },
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("failed");
  const lifecycleActivities = (
    await inner.listActivityEvents("ws_test001")
  ).filter(
    (event) =>
      event.runId === applyRun.id &&
      event.action.startsWith("release_activation."),
  );
  expect(lifecycleActivities.map((event) => event.action)).toEqual([
    "release_activation.succeeded",
    "release_activation.pending",
  ]);
});

test("lifecycle actions are pinned with the Plan instead of reread from mutable InstallConfig", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "reviewed",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "run", "reviewed"],
      },
    ]),
  });
  const activations: ReleaseActivationInput[] = [];
  const controller = controllerWith(store, runner, {
    releaseActivator: {
      activate: (input) => {
        activations.push(input);
        return Promise.resolve({ status: "succeeded" });
      },
    },
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  await store.putInstallConfig({
    ...seeded.installConfig,
    ...lifecycleInstallConfig([
      {
        id: "changed-after-plan",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "run", "changed"],
      },
    ]),
  });
  await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(activations[0]?.commands.map((command) => command.id)).toEqual([
    "reviewed",
  ]);
});

test("a former lifecycle output name is ordinary data and never triggers actions", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner(
    {},
    {
      takosumi_release: {
        sensitive: false,
        value: { status: "ordinary-module-data" },
      },
      launch_url: { sensitive: false, value: "https://takos.example" },
    },
  );
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: {
      outputAllowlist: {
        takosumi_release: { from: "takosumi_release", type: "json" },
      },
    },
  });
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

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect(activations).toHaveLength(0);
  expect(applyRun.outputId).toBeDefined();
  const output = await store.getOutput(applyRun.outputId!);
  expect(output?.publicOutputs).toEqual({
    takosumi_release: { status: "ordinary-module-data" },
  });
  expect(output?.workspaceOutputs.takosumi_release).toEqual({
    status: "ordinary-module-data",
  });
});

test("post-apply lifecycle actions never fall back to Output data", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const originalCommit = store.commitRunState.bind(store);
  store.commitRunState = (
    input: Parameters<OpenTofuControlStore["commitRunState"]>[0],
  ) => {
    if (input.output) {
      const mutable = input.output as unknown as {
        workspaceOutputs: Record<string, unknown>;
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
    }
    return originalCommit(input);
  };
  const runner = recordingRunner(
    {},
    {
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableCapsuleModel(store, { environment: "preview" });
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

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect(activations).toHaveLength(0);
});

test("runner release commands receive dispatch-only provider credentials", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner(
    {},
    {
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "publish",
        phase: "post_apply",
        executor: "runner",
        command: ["bun", "run", "app:activate"],
        workingDirectory: ".",
        timeoutSeconds: 1200,
        useProviderCredentials: true,
      },
    ]),
  });
  const boundConnection = await store.getConnection(
    "conn_fixture_ws_test001_cloudflare",
  );
  expect(boundConnection).toBeDefined();
  await store.putConnection({
    ...boundConnection!,
    scopeHints: {
      ...boundConnection!.scopeHints,
      providerConfig: {
        base_url: "https://provider.example.test/api",
      },
    },
  });
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

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
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
      useProviderCredentials: true,
    },
  ]);
  expect(activations[0]?.credentials).toMatchObject({
    env: { CLOUDFLARE_API_TOKEN: "fixture-provider-token" },
    manifest: {
      bindings: [
        expect.objectContaining({
          providerSource: "registry.opentofu.org/cloudflare/cloudflare",
          alias: "main",
          authMode: "env",
          envNames: ["CLOUDFLARE_API_TOKEN"],
        }),
      ],
    },
  });
  expect(activations[0]?.providerConfigurations).toEqual({
    format: "takosumi.provider-configurations@v1",
    providers: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "main",
        configuration: {
          base_url: "https://provider.example.test/api",
        },
      },
    ],
  });

  const activity = (await store.listActivityEvents("ws_test001")).find(
    (event) => event.action === "release_activation.succeeded",
  );
  expect(JSON.stringify(activity)).not.toContain("fixture-provider-token");
});

test("operator lifecycle actions do not receive ProviderConnection material", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner(
    {},
    {
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "publish",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "run", "app:activate"],
        workingDirectory: ".",
        timeoutSeconds: 1200,
      },
    ]),
  });
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

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
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
  expect(activations[0]?.credentials).toBeUndefined();

  const activity = (await store.listActivityEvents("ws_test001")).find(
    (event) => event.action === "release_activation.succeeded",
  );
  expect(JSON.stringify(activity)).not.toContain("fixture-provider-token");
});

test("output command-shaped data is ignored in favor of the validated InstallConfig action", async () => {
  const store = new InMemoryOpenTofuControlStore();
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
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "app-activation-is-opaque",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "run", "app:activate"],
        workingDirectory: "backend",
        env: {
          APP_RELEASE_TARGET: "production",
          BAD_NAME: "ok",
        },
      },
    ]),
  });
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

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
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

test("post-apply lifecycle execution renews the run heartbeat and Capsule lease", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "publish",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "run", "release"],
      },
    ]),
  });
  let clock = 10_000;
  const now = () => (clock += 1);
  const observed = observingCapsuleCoordination(now);
  let releaseActivation!: () => void;
  const activationHold = new Promise<void>((resolve) => {
    releaseActivation = resolve;
  });
  let activationEntered!: (input: {
    readonly applyRunId: string;
    readonly heartbeatAt: number;
  }) => void;
  const entered = new Promise<{
    readonly applyRunId: string;
    readonly heartbeatAt: number;
  }>((resolve) => {
    activationEntered = resolve;
  });
  const controller = controllerWith(store, runner, {
    now,
    capsuleCoordination: observed.coordination,
    runRenewalIntervalMs: 5,
    releaseActivator: {
      activate: async (input) => {
        activationEntered({
          applyRunId: input.applyRun.id,
          heartbeatAt:
            (await store.getApplyRun(input.applyRun.id))?.heartbeatAt ?? 0,
        });
        await activationHold;
        return { status: "succeeded" };
      },
    },
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const applying = controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  const blocked = await expectWithin(entered, 1_000);
  const renewedHeartbeat = await waitForRenewedApplyHeartbeat({
    store,
    applyRunId: blocked.applyRunId,
    initialHeartbeat: blocked.heartbeatAt,
    renewCalls: observed.renewCalls,
  });

  expect(renewedHeartbeat).toBeGreaterThan(blocked.heartbeatAt);
  expect(runner.applyJobs).toHaveLength(1);
  releaseActivation();
  expect((await applying).applyRun.status).toBe("succeeded");
});

test("pre-destroy lifecycle execution renews before provider destroy dispatch", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "retire-runtime",
        phase: "pre_destroy",
        executor: "operator",
        command: ["bun", "run", "release", "--destroy"],
      },
    ]),
  });
  let clock = 20_000;
  const now = () => (clock += 1);
  const observed = observingCapsuleCoordination(now);
  let releaseActivation!: () => void;
  const activationHold = new Promise<void>((resolve) => {
    releaseActivation = resolve;
  });
  let activationEntered!: (input: {
    readonly applyRunId: string;
    readonly heartbeatAt: number;
  }) => void;
  const entered = new Promise<{
    readonly applyRunId: string;
    readonly heartbeatAt: number;
  }>((resolve) => {
    activationEntered = resolve;
  });
  const controller = controllerWith(store, runner, {
    now,
    capsuleCoordination: observed.coordination,
    runRenewalIntervalMs: 5,
    releaseActivator: {
      activate: async (input) => {
        activationEntered({
          applyRunId: input.applyRun.id,
          heartbeatAt:
            (await store.getApplyRun(input.applyRun.id))?.heartbeatAt ?? 0,
        });
        await activationHold;
        return { status: "succeeded" };
      },
    },
  });

  const create = await controller.createCapsulePlan("cap_fixture1");
  await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });
  const destroy = await controller.createCapsuleDestroyPlan("cap_fixture1");
  await controller.approveRun(destroy.planRun.id);
  const renewCallsBeforeDestroy = observed.renewCalls();
  const destroying = controller.createApplyRun({
    planRunId: destroy.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroy.planRun),
  });
  const blocked = await expectWithin(entered, 1_000);
  await waitForRenewedApplyHeartbeat({
    store,
    applyRunId: blocked.applyRunId,
    initialHeartbeat: blocked.heartbeatAt,
    renewCalls: observed.renewCalls,
    initialRenewCalls: renewCallsBeforeDestroy,
  });

  expect(runner.destroyJobs).toHaveLength(0);
  releaseActivation();
  expect((await destroying).applyRun.status).toBe("succeeded");
  expect(runner.destroyJobs).toHaveLength(1);
});

test("pre-destroy release commands run before OpenTofu destroy", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner(
    {},
    {
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  const originalDestroy = runner.destroy!.bind(runner);
  const events: string[] = [];
  let preDestroyEvidenceWasDurable = false;
  runner.destroy = async (job) => {
    events.push("destroy");
    preDestroyEvidenceWasDurable = Boolean(
      (await store.getApplyRun(job.applyRun.id))?.auditEvents.some(
        (event) => event.type === "lifecycle_action.pre_destroy.succeeded",
      ),
    );
    return await originalDestroy(job);
  };
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "delete-worker",
        phase: "pre_destroy",
        executor: "operator",
        command: ["bun", "run", "takosumi:release", "--", "--destroy"],
        workingDirectory: ".",
      },
    ]),
  });
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

  const create = await controller.createCapsulePlan("cap_fixture1");
  const createApply = await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });
  expect(createApply.applyRun.status).toBe("succeeded");
  activations.length = 0;
  events.length = 0;

  const destroy = await controller.createCapsuleDestroyPlan("cap_fixture1");
  await controller.approveRun(destroy.planRun.id);
  const { applyRun } = await controller.createApplyRun({
    planRunId: destroy.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroy.planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect(runner.destroyJobs).toHaveLength(1);
  expect(events).toEqual(["activate:pre_destroy", "destroy"]);
  expect(preDestroyEvidenceWasDurable).toBe(true);
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
  expect(
    applyRun.auditEvents.find(
      (event) => event.type === "lifecycle_action.pre_destroy.succeeded",
    )?.data,
  ).toMatchObject({
    phase: "pre_destroy",
    status: "succeeded",
    commandCount: 1,
    actionDispatched: true,
  });
});

test("successful pre_destroy evidence survives retryable destroy requeue and blocks cancellation", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  let destroyCalls = 0;
  runner.destroy = () => {
    destroyCalls += 1;
    return Promise.reject(
      new OpenTofuRunnerInfrastructureError(
        "runner substrate reset after pre_destroy",
        { reason: "substrate_reset" },
      ),
    );
  };
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "retire-runtime",
        phase: "pre_destroy",
        executor: "operator",
        command: ["bun", "run", "release", "--destroy"],
      },
    ]),
  });
  const queued: Array<{
    readonly action: "plan" | "apply" | "source_sync" | "restore";
    readonly runId: string;
    readonly workspaceId: string;
  }> = [];
  const controller = controllerWith(store, runner, {
    enqueueRun: (dispatch) => {
      queued.push(dispatch);
      return Promise.resolve();
    },
    releaseActivator: {
      activate: () => Promise.resolve({ status: "succeeded" }),
    },
  });

  const createQueued = await controller.createCapsulePlan("cap_fixture1");
  await controller.dispatchQueuedRun(queued.shift()!);
  const createPlan = (await store.getPlanRun(createQueued.planRun.id))!;
  const createApplyQueued = await controller.createApplyRun({
    planRunId: createPlan.id,
    expected: applyExpectedGuardFromPlanRun(createPlan),
  });
  await controller.dispatchQueuedRun(queued.shift()!);
  expect((await store.getApplyRun(createApplyQueued.applyRun.id))?.status).toBe(
    "succeeded",
  );

  const destroyQueued =
    await controller.createCapsuleDestroyPlan("cap_fixture1");
  await controller.dispatchQueuedRun(queued.shift()!);
  const destroyPlan = (await store.getPlanRun(destroyQueued.planRun.id))!;
  await controller.approveRun(destroyPlan.id);
  const destroyApplyQueued = await controller.createApplyRun({
    planRunId: destroyPlan.id,
    expected: applyExpectedGuardFromPlanRun(destroyPlan),
  });
  await controller.dispatchQueuedRun(queued.shift()!);

  const requeued = (await store.getApplyRun(destroyApplyQueued.applyRun.id))!;
  expect(requeued.status).toBe("queued");
  expect(requeued.startedAt).toBeDefined();
  expect(destroyCalls).toBe(1);
  expect(
    requeued.auditEvents.find(
      (event) => event.type === "lifecycle_action.pre_destroy.succeeded",
    )?.data,
  ).toMatchObject({
    phase: "pre_destroy",
    status: "succeeded",
    actionDispatched: true,
  });
  await expect(controller.cancelRun(requeued.id)).rejects.toThrow(
    /has already started/,
  );
  expect(await store.getCapsuleRuntimeSafety("cap_fixture1")).toMatchObject({
    phase: "terminating",
    runId: requeued.id,
    runType: "destroy_apply",
  });
});

test("pre-destroy lifecycle failure blocks OpenTofu destroy", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner(
    {},
    {
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "delete-worker",
        phase: "pre_destroy",
        executor: "operator",
        command: ["bun", "run", "takosumi:release", "--", "--destroy"],
        workingDirectory: ".",
      },
    ]),
  });
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

  const create = await controller.createCapsulePlan("cap_fixture1");
  await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });

  const destroy = await controller.createCapsuleDestroyPlan("cap_fixture1");
  await controller.approveRun(destroy.planRun.id);
  const { applyRun, capsule } = await controller.createApplyRun({
    planRunId: destroy.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroy.planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(applyRun.diagnostics).toContainEqual(
    expect.objectContaining({ code: "capsule_lifecycle_action_failed" }),
  );
  expect(runner.destroyJobs).toHaveLength(0);
  expect(capsule?.status).toBe("active");
  expect(
    applyRun.auditEvents.find(
      (event) => event.type === "lifecycle_action.pre_destroy.failed",
    )?.data,
  ).toMatchObject({
    phase: "pre_destroy",
    status: "failed",
    commandCount: 1,
    actionDispatched: true,
  });
  expect(
    applyRun.auditEvents.find((event) => event.type === "destroy.failed")?.data,
  ).toMatchObject({
    lifecycleActionPhase: "pre_destroy",
    lifecycleActionStatus: "failed",
    lifecycleActionCommandCount: 1,
  });
  expect(await store.getCapsuleRuntimeSafety("cap_fixture1")).toMatchObject({
    phase: "unknown",
    runId: applyRun.id,
    runType: "destroy_apply",
  });
  const activity = (await store.listActivityEvents("ws_test001")).find(
    (event) => event.action === "release_activation.failed",
  );
  expect(activity?.metadata).toMatchObject({
    commandCount: 1,
    message: "worker artifact was already absent",
  });
});

test("pre-destroy lifecycle skipped result blocks OpenTofu destroy", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner(
    {},
    {
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "delete-worker",
        phase: "pre_destroy",
        executor: "operator",
        command: ["bun", "run", "takosumi:release", "--", "--destroy"],
        workingDirectory: ".",
      },
    ]),
  });
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

  const create = await controller.createCapsulePlan("cap_fixture1");
  await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });

  const destroy = await controller.createCapsuleDestroyPlan("cap_fixture1");
  await controller.approveRun(destroy.planRun.id);
  const { applyRun, capsule } = await controller.createApplyRun({
    planRunId: destroy.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroy.planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(runner.destroyJobs).toHaveLength(0);
  expect(capsule?.status).toBe("active");
  expect(await store.getCapsuleRuntimeSafety("cap_fixture1")).toMatchObject({
    phase: "unknown",
    runId: applyRun.id,
    runType: "destroy_apply",
  });
  const activity = (await store.listActivityEvents("ws_test001")).find(
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

test("pre-destroy lifecycle pending result blocks OpenTofu destroy", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "delete-worker",
        phase: "pre_destroy",
        executor: "operator",
        command: ["bun", "run", "release", "--destroy"],
      },
    ]),
  });
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: () =>
        Promise.resolve({ status: "pending", message: "queued elsewhere" }),
    },
  });

  const create = await controller.createCapsulePlan("cap_fixture1");
  await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });
  const destroy = await controller.createCapsuleDestroyPlan("cap_fixture1");
  await controller.approveRun(destroy.planRun.id);
  const { applyRun, capsule } = await controller.createApplyRun({
    planRunId: destroy.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroy.planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(applyRun.diagnostics).toContainEqual(
    expect.objectContaining({ code: "capsule_lifecycle_action_failed" }),
  );
  expect(runner.destroyJobs).toHaveLength(0);
  expect(capsule?.status).toBe("active");
  expect(
    (await store.listActivityEvents("ws_test001")).find(
      (event) =>
        event.runId === applyRun.id &&
        event.action === "release_activation.failed",
    )?.metadata,
  ).toMatchObject({ message: "queued elsewhere", commandCount: 1 });
});

test("pre-destroy lifecycle exception blocks OpenTofu destroy", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "delete-worker",
        phase: "pre_destroy",
        executor: "operator",
        command: ["bun", "run", "release", "--destroy"],
      },
    ]),
  });
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: () => Promise.reject(new Error("operator unavailable")),
    },
  });

  const create = await controller.createCapsulePlan("cap_fixture1");
  await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });
  const destroy = await controller.createCapsuleDestroyPlan("cap_fixture1");
  await controller.approveRun(destroy.planRun.id);
  const { applyRun, capsule } = await controller.createApplyRun({
    planRunId: destroy.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroy.planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(runner.destroyJobs).toHaveLength(0);
  expect(capsule?.status).toBe("active");
  expect(
    (await store.listActivityEvents("ws_test001")).find(
      (event) =>
        event.runId === applyRun.id &&
        event.action === "release_activation.failed",
    )?.metadata,
  ).toMatchObject({ message: "operator unavailable", commandCount: 1 });
});

test("pre-destroy release commands fail destroy when no release activator is configured", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner(
    {},
    {
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "delete-worker",
        phase: "pre_destroy",
        executor: "runner",
        command: ["bun", "run", "takosumi:release", "--destroy"],
      },
    ]),
  });
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
  });

  const create = await controller.createCapsulePlan("cap_fixture1");
  await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });
  const destroy = await controller.createCapsuleDestroyPlan("cap_fixture1");
  await controller.approveRun(destroy.planRun.id);
  const { applyRun, capsule } = await controller.createApplyRun({
    planRunId: destroy.planRun.id,
    expected: applyExpectedGuardFromPlanRun(destroy.planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(runner.destroyJobs).toHaveLength(0);
  expect(capsule?.status).toBe("active");
  expect(await store.getCapsuleRuntimeSafety("cap_fixture1")).toMatchObject({
    phase: "safe",
    runType: "apply",
  });
  const activity = (await store.listActivityEvents("ws_test001")).find(
    (event) => event.action === "release_activation.failed",
  );
  expect(activity?.metadata).toMatchObject({
    activationKind: "takosumi.install-config-actions@v1",
    commandCount: 1,
    message:
      "pre-destroy lifecycle actions declared but no release activator is configured",
  });
});

test("post-apply lifecycle actions fail closed when no activator is configured", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner(
    {},
    {
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "publish",
        phase: "post_apply",
        executor: "runner",
        command: ["bun", "run", "release"],
      },
    ]),
  });
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun, capsule } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(capsule?.status).toBe("error");
  expect(await store.getStateVersion(applyRun.stateVersionId!)).toBeDefined();
  expect(await store.getOutput(applyRun.outputId!)).toBeDefined();
  const activity = (await store.listActivityEvents("ws_test001")).find(
    (event) => event.action === "release_activation.failed",
  );
  expect(activity).toBeDefined();
  expect(activity?.metadata).toMatchObject({
    activationKind: "takosumi.install-config-actions@v1",
    commandCount: 1,
    message:
      "post-apply lifecycle actions declared but no release activator is configured",
  });
});

test("post-apply lifecycle exception retains state but fails readiness", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "publish",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "run", "release"],
      },
    ]),
  });
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: () =>
        Promise.reject(new Error("activation healthcheck failed")),
    },
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun, capsule } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(capsule?.status).toBe("error");
  const activity = (await store.listActivityEvents("ws_test001")).find(
    (event) => event.action === "release_activation.failed",
  );
  expect(activity).toBeDefined();
  const stateVersion = await store.getStateVersion(activity!.targetId);
  expect(stateVersion?.id).toBe(applyRun.stateVersionId);
  expect(activity?.metadata).toMatchObject({
    capsuleId: "cap_fixture1",
    applyRunId: applyRun.id,
    outputCount: 3,
    message: "activation healthcheck failed",
  });
});

test("post-apply lifecycle skipped result retains state but fails readiness", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner(
    {},
    {
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "publish",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "run", "release"],
      },
    ]),
  });
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

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun, capsule } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(capsule?.status).toBe("error");
  expect(await store.getStateVersion(applyRun.stateVersionId!)).toBeDefined();
  expect(await store.getOutput(applyRun.outputId!)).toBeDefined();
  const activity = (await store.listActivityEvents("ws_test001")).find(
    (event) => event.action === "release_activation.failed",
  );
  expect(activity?.metadata).toMatchObject({
    activationKind: "operator.release",
    commandCount: 1,
    message: "release activator skipped declared post-apply commands",
  });
});

test("post-apply lifecycle failed result retains state but fails readiness", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "publish",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "run", "release"],
      },
    ]),
  });
  const controller = controllerWith(store, runner, {
    activity: activityRecorderFor(store),
    releaseActivator: {
      activate: () =>
        Promise.resolve({ status: "failed", message: "healthcheck failed" }),
    },
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun, capsule } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(capsule?.status).toBe("error");
  expect(await store.getStateVersion(applyRun.stateVersionId!)).toBeDefined();
  expect(await store.getOutput(applyRun.outputId!)).toBeDefined();
  expect(
    applyRun.auditEvents.find(
      (event) => event.type === "lifecycle_action.post_apply.failed",
    )?.data,
  ).toMatchObject({
    status: "failed",
    actionDispatched: true,
  });
});

test("a fresh reviewed plan/apply recovers a Capsule after post-apply lifecycle failure", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "publish",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "run", "release"],
      },
    ]),
  });
  let attempts = 0;
  const controller = controllerWith(store, runner, {
    releaseActivator: {
      activate: () => {
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? { status: "failed" as const, message: "not healthy" }
            : { status: "succeeded" as const },
        );
      },
    },
  });

  const { planRun: firstPlan } =
    await controller.createCapsulePlan("cap_fixture1");
  const first = await controller.createApplyRun({
    planRunId: firstPlan.id,
    expected: applyExpectedGuardFromPlanRun(firstPlan),
  });
  expect(first.applyRun.status).toBe("failed");
  expect(first.capsule?.status).toBe("error");
  expect(first.capsule?.currentStateGeneration).toBe(1);

  const replay = await controller.createApplyRun({
    planRunId: firstPlan.id,
    expected: applyExpectedGuardFromPlanRun(firstPlan),
  });
  expect(replay.applyRun.id).toBe(first.applyRun.id);
  expect(replay.applyRun.status).toBe("failed");
  expect(runner.applyJobs).toHaveLength(1);

  const { planRun: recoveryPlan } =
    await controller.createCapsulePlan("cap_fixture1");
  expect(recoveryPlan.baseStateGeneration).toBe(1);
  const recovered = await controller.createApplyRun({
    planRunId: recoveryPlan.id,
    expected: applyExpectedGuardFromPlanRun(recoveryPlan),
  });

  expect(recovered.applyRun.status).toBe("succeeded");
  expect(recovered.capsule?.status).toBe("active");
  expect(recovered.capsule?.currentStateGeneration).toBe(2);
  expect(recovered.applyRun.id).not.toBe(first.applyRun.id);
  expect(runner.applyJobs).toHaveLength(2);
  expect(attempts).toBe(2);
});

test("post-apply lifecycle failure captures provider usage and billing", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: lifecycleInstallConfig([
      {
        id: "publish",
        phase: "post_apply",
        executor: "operator",
        command: ["bun", "run", "release"],
      },
    ]),
  });
  const captures: Parameters<BillingEnforcement["captureRunBilling"]>[0][] = [];
  const releases: Parameters<BillingEnforcement["releaseReservation"]>[0][] =
    [];
  const billingEnforcement: BillingEnforcement = {
    reservePlanBilling: () => Promise.resolve({ reasons: [] }),
    assertReservationSatisfied: () => Promise.resolve(),
    captureRunBilling: (context) => {
      captures.push(context);
      return Promise.resolve();
    },
    releaseReservation: (context) => {
      releases.push(context);
      return Promise.resolve();
    },
  };
  const controller = controllerWith(store, runner, {
    defaultBillingSettings: { mode: "showback" },
    billingEnforcement,
    releaseActivator: {
      activate: () => Promise.resolve({ status: "failed" }),
    },
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("failed");
  expect(await store.listUsageEvents("ws_test001")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        runId: applyRun.id,
        kind: "opentofu.apply",
        source: "runner",
      }),
      expect.objectContaining({
        runId: applyRun.id,
        kind: "runner_minute",
        source: "runner",
      }),
    ]),
  );
  expect(captures).toEqual([
    expect.objectContaining({
      runId: planRun.id,
      applyRunId: applyRun.id,
      capsuleId: "cap_fixture1",
    }),
  ]);
  expect(releases).toEqual([]);
});

test("post-commit billing capture stays pending and retries idempotently without releasing", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(store, { environment: "preview" });
  const captures: Parameters<BillingEnforcement["captureRunBilling"]>[0][] = [];
  const releases: Parameters<BillingEnforcement["releaseReservation"]>[0][] =
    [];
  let captureAttempts = 0;
  const billingEnforcement: BillingEnforcement = {
    reservePlanBilling: () => Promise.resolve({ reasons: [] }),
    assertReservationSatisfied: () => Promise.resolve(),
    captureRunBilling: (context) => {
      captures.push(context);
      captureAttempts += 1;
      return captureAttempts === 1
        ? Promise.reject(new Error("transient billing host outage"))
        : Promise.resolve();
    },
    releaseReservation: (context) => {
      releases.push(context);
      return Promise.resolve();
    },
  };
  const controller = controllerWith(store, runner, {
    defaultBillingSettings: { mode: "showback" },
    billingEnforcement,
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const first = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(first.applyRun.status).toBe("succeeded");
  expect(
    first.applyRun.auditEvents.some(
      (event) => event.type === "billing.capture.pending",
    ),
  ).toBe(true);
  expect(
    first.applyRun.auditEvents.some(
      (event) => event.type === "billing.capture.completed",
    ),
  ).toBe(false);
  expect(releases).toEqual([]);

  const repaired = await controller.runQueuedApply(first.applyRun.id);
  expect(repaired.applyRun.status).toBe("succeeded");
  expect(
    repaired.applyRun.auditEvents.some(
      (event) => event.type === "billing.capture.completed",
    ),
  ).toBe(true);
  expect(captures).toHaveLength(2);
  expect(captures[0]).toMatchObject({
    runId: planRun.id,
    applyRunId: first.applyRun.id,
  });
  expect(captures[1]).toMatchObject({
    runId: planRun.id,
    applyRunId: first.applyRun.id,
  });
  expect(releases).toEqual([]);
  expect(
    (await store.listUsageEvents("ws_test001")).filter(
      (event) =>
        event.runId === first.applyRun.id && event.kind === "opentofu.apply",
    ),
  ).toHaveLength(1);
});

test("release activator skipped result without commands remains a no-op", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner(
    {},
    {
      launch_url: { sensitive: false, value: "https://x.example" },
    },
  );
  await seedRunnableCapsuleModel(store, { environment: "preview" });
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

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.status).toBe("succeeded");
  expect(
    (await store.listActivityEvents("ws_test001")).some((event) =>
      event.action.startsWith("release_activation."),
    ),
  ).toBe(false);
});

test("Workspace-owned ProviderConnection apply is not capped by host-managed policy", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
    environment: "preview",
  });
  // A Workspace-owned ProviderConnection is bound explicitly; unrelated host
  // capacity policy must not reinterpret it as an operator-owned credential.
  await putConnectionWithProviderEnv(store, {
    id: "conn_self_cf",
    scope: "workspace",
    workspaceId: seeded.capsule.workspaceId,
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    kind: "cloudflare_api_token",
    displayName: "Self-host Cloudflare",
    status: "verified",
    scopeJson: {},
    secretRef: "sec_self_cf",
    createdAt: "2026-06-07T00:00:00.000Z",
  } as never);
  await store.putProviderBindingSet({
    id: "profile_self",
    workspaceId: seeded.capsule.workspaceId,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        alias: "main",
        connectionId: "conn_self_cf",
      },
    ],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
  });
  const controller = new OpenTofuController({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    runner,
    vault: fakeProviderVault() as never,
    now: sequenceNow(1),
    newId: deterministicIds(),
  });

  // A sibling Capsule can carry an unrelated generation count; OSS
  // Workspace Provider Connections are not governed by host-managed caps.
  const inst = await store.getCapsule("cap_fixture1");
  await store.putCapsule({
    ...inst!,
    id: "inst_sibling",
    slug: "sibling",
    name: "sibling",
    currentStateGeneration: 10,
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  expect(planRun.status).toBe("succeeded");

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun.status).toBe("succeeded");
});

test("showback records usage while the plan USD amount remains estimate-only", async () => {
  const { store, controller } = await seededController(
    {},
    { defaultBillingSettings: { mode: "showback" } },
  );

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  expect(planRun.status).toBe("succeeded");
  expect(await controller.getRunCost(planRun.id)).toMatchObject({
    billingMode: "showback",
    estimatedUsdMicros: 0,
    blocked: false,
    reasons: [],
  });

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun.status).toBe("succeeded");

  const usageEvents = await store.listUsageEvents("ws_test001");
  expect(usageEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        workspaceId: "ws_test001",
        capsuleId: "cap_fixture1",
        runId: applyRun.id,
        kind: "opentofu.apply",
        usdMicros: 0,
        ratingStatus: "unrated",
        source: "runner",
      }),
    ]),
  );
  const runnerUsageEvents = usageEvents.filter(
    (event) => event.kind === "runner_minute",
  );
  expect(runnerUsageEvents).toEqual([
    expect.objectContaining({
      workspaceId: "ws_test001",
      runId: planRun.id,
      source: "runner",
    }),
    expect.objectContaining({
      workspaceId: "ws_test001",
      runId: applyRun.id,
      source: "runner",
    }),
  ]);
  for (const event of runnerUsageEvents) {
    expect(event.usdMicros).toBe(0);
    expect(event.ratingStatus).toBe("unrated");
    expect(event).not.toHaveProperty("credits");
  }
  expect(await controller.getCapsuleUsageSummary("cap_fixture1")).toEqual({
    capsuleId: "cap_fixture1",
    usdMicros: 0,
    eventCount: 3,
    ratedEventCount: 0,
    unratedEventCount: 3,
  });
});

async function showbackEstimatedUsdMicrosFor(
  planResourceChanges: readonly PlanResourceChange[],
  showbackRater?: ShowbackRater,
): Promise<number> {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner({
    planResourceChanges: [...planResourceChanges],
  });
  await seedRunnableCapsuleModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner, {
    defaultBillingSettings: { mode: "showback" },
    ...(showbackRater ? { showbackRater } : {}),
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  expect(planRun.status).toBe("succeeded");
  return (await controller.getRunCost(planRun.id)).estimatedUsdMicros;
}

test("OSS plan showback stays zero and unrated without a host rater", async () => {
  expect(
    await showbackEstimatedUsdMicrosFor([
      { address: "a.one", type: "a", actions: ["create"] },
      { address: "a.two", type: "a", actions: ["create"] },
      { address: "a.three", type: "a", actions: ["create"] },
    ]),
  ).toBe(0);
});

test("an injected host rater is the only plan price authority", async () => {
  const rater: ShowbackRater = {
    async ratePlan(ctx) {
      return {
        ratingStatus: "rated",
        usdMicros: ctx.planResourceChanges.length * 125_000,
      };
    },
    async rateUsage() {
      return { ratingStatus: "rated", usdMicros: 7_500 };
    },
  };
  expect(
    await showbackEstimatedUsdMicrosFor(
      [
        { address: "a.create", type: "a", actions: ["create"] },
        { address: "a.update", type: "a", actions: ["update"] },
        { address: "a.delete", type: "a", actions: ["delete"] },
        { address: "a.replace", type: "a", actions: ["delete", "create"] },
        { address: "a.noop", type: "a", actions: ["no-op"] },
      ],
      rater,
    ),
  ).toBe(625_000);
});

test("host-rated plan and runner measurements persist explicit rated evidence", async () => {
  const rater: ShowbackRater = {
    async ratePlan() {
      return { ratingStatus: "rated", usdMicros: 125_000 };
    },
    async rateUsage() {
      return { ratingStatus: "rated", usdMicros: 7_500 };
    },
  };
  const { store, controller } = await seededController(
    {},
    {
      defaultBillingSettings: { mode: "showback" },
      showbackRater: rater,
    },
  );
  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  const usage = await store.listUsageEvents("ws_test001");

  expect(usage).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        runId: applyRun.id,
        kind: "opentofu.apply",
        usdMicros: 125_000,
        ratingStatus: "rated",
      }),
      expect.objectContaining({
        runId: planRun.id,
        kind: "runner_minute",
        usdMicros: 7_500,
        ratingStatus: "rated",
      }),
      expect.objectContaining({
        runId: applyRun.id,
        kind: "runner_minute",
        usdMicros: 7_500,
        ratingStatus: "rated",
      }),
    ]),
  );
  expect(await controller.getCapsuleUsageSummary("cap_fixture1")).toEqual({
    capsuleId: "cap_fixture1",
    usdMicros: 140_000,
    eventCount: 3,
    ratedEventCount: 3,
    unratedEventCount: 0,
  });
});

test("resource meter usage is Workspace-scoped, idempotent, and provider-neutral", async () => {
  const { store, controller } = await seededController();

  const first = await controller.recordMeteredUsage("ws_test001", {
    capsuleId: "cap_fixture1",
    kind: "storage.gb_hour",
    quantity: 12.5,
    usdMicros: 300_000,
    ratingStatus: "rated",
    source: "operator.storage-meter.v2",
    idempotencyKey: "meter:cap_fixture1:storage:2026-06-07T00",
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  const second = await controller.recordMeteredUsage("ws_test001", {
    capsuleId: "cap_fixture1",
    kind: "storage.gb_hour",
    quantity: 99,
    usdMicros: 99_000_000,
    ratingStatus: "rated",
    source: "operator.storage-meter.v2",
    idempotencyKey: "meter:cap_fixture1:storage:2026-06-07T00",
    createdAt: "2026-06-07T00:30:00.000Z",
  });

  expect(second.usageEvent).toEqual(first.usageEvent);
  expect(await store.listUsageEvents("ws_test001")).toEqual([
    expect.objectContaining({
      workspaceId: "ws_test001",
      capsuleId: "cap_fixture1",
      kind: "storage.gb_hour",
      quantity: 12.5,
      usdMicros: 300_000,
      ratingStatus: "rated",
      source: "operator.storage-meter.v2",
    }),
  ]);
  await expect(
    controller.recordMeteredUsage("ws_test001", {
      kind: "runner_minute",
      quantity: 1,
      usdMicros: 1_000,
      ratingStatus: "rated",
      source: "runner" as never,
      idempotencyKey: "operator:bad-runner-source",
    }),
  ).rejects.toThrow("usage source must be a valid non-runner producer token");
  await expect(
    controller.recordMeteredUsage("ws_test001", {
      kind: "compute.operation",
      quantity: 1,
      usdMicros: 1_000,
      ratingStatus: "rated",
      meterId: "portable:service:deploy",
      resourceFamily: "portable.service",
      source: "resource_meter",
      idempotencyKey: "operator:bad-metadata-key",
      resourceMetadata: {
        workers_for_platforms_backend: "true",
      },
    }),
  ).rejects.toThrow(
    "usage resourceMetadata keys must be non-empty public names",
  );
  await expect(
    controller.recordMeteredUsage("ws_test001", {
      kind: "custom.measurement",
      quantity: 1,
      usdMicros: 1,
      ratingStatus: "unrated",
      source: "operator.custom-meter",
      idempotencyKey: "operator:unrated-nonzero",
    }),
  ).rejects.toThrow("unrated usage must have zero usdMicros");
});

test("capsule plan returns a typed source_sync_required 409 when no snapshot exists", async () => {
  const { runner, controller } = await seededController({
    withoutSnapshot: true,
  });

  await expect(
    controller.createCapsulePlan("cap_fixture1"),
  ).rejects.toMatchObject({
    code: "failed_precondition",
    details: { reason: "source_sync_required" },
  });
  await expect(controller.createCapsulePlan("cap_fixture1")).rejects.toThrow(
    /source_sync_required/,
  );
  expect(runner.planJobs).toHaveLength(0);
});

test("capsule destroy-plan completes and the unified Run is waiting_approval", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner({
    plannedOutputs: {
      launch_url: { sensitive: false, value: null },
    },
  });
  await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: {
      outputAllowlist: {
        launch_url: {
          from: "launch_url",
          type: "url",
          required: true,
        },
      },
    },
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createCapsuleDestroyPlan("cap_fixture1");
  expect(planRun.operation).toEqual("destroy");
  // A destroy plan ALWAYS lands the PERSISTED `waiting_approval` status (spec
  // §19 two-stage destroy), independent of the environment's approval gate.
  expect(planRun.status).toEqual("waiting_approval");

  const run = await controller.getRun(planRun.id);
  expect(run.type).toEqual("destroy_plan");
  expect(run.status).toEqual("waiting_approval");

  // The destroy plan dispatch still carries the capsule state scope + archive.
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]!.stateScope?.generation).toEqual(0);
  expect(runner.planJobs[0]!.sourceArchive?.ref).toEqual(ARCHIVE_KEY);
});

test("capsule apply emits generation base+1, records StateVersion + Output, and advances the Capsule", async () => {
  const { store, runner, controller } = await seededController();

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  expect(applyRun.status).toEqual("succeeded");

  // Apply persists state at base+1 (= 1).
  expect(runner.applyJobs).toHaveLength(1);
  const applyJob = runner.applyJobs[0]!;
  expect(applyJob.stateScope).toMatchObject({
    workspaceId: "ws_test001",
    environment: "preview",
    generation: 1,
    subject: { kind: "capsule", id: "cap_fixture1" },
  });
  expect(applyJob.sourceArchive).toEqual({
    ref: ARCHIVE_KEY,
    digest: FIXTURE_ARCHIVE_DIGEST,
  });

  // The StateVersion is recorded at generation 1 with the runner's digest and
  // the spec §20 R2_STATE object key (capsule-keyed).
  const latest = await store.getLatestStateVersion("cap_fixture1", "preview");
  expect(latest?.generation).toEqual(1);
  expect(latest?.digest).toEqual(STATE_DIGEST);
  expect(latest?.capsuleId).toEqual("cap_fixture1");
  expect(latest?.environment).toEqual("preview");
  expect(latest?.id).toEqual(applyRun.stateVersionId);
  expect(latest?.stateRef).toMatch(/\/00000001\.tfstate\.enc$/);

  const output = await store.getOutput(applyRun.outputId!);
  expect(output?.capsuleId).toEqual("cap_fixture1");
  expect(output?.stateGeneration).toEqual(1);
  expect(output?.publicOutputs).toMatchObject({
    launch_url: "https://x.example",
  });
  expect(await store.getPlanRunInputs(planRun.id)).toBeUndefined();

  const capsule = await store.getCapsule("cap_fixture1");
  expect(capsule?.status).toEqual("active");
  expect(capsule?.currentStateGeneration).toEqual(1);
  expect(capsule?.currentStateVersionId).toEqual(applyRun.stateVersionId);
  expect(capsule?.currentOutputId).toEqual(applyRun.outputId);
});

test("capsule plan and apply record deploy operation metrics", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const observability = new InMemoryObservabilitySink();
  await seedRunnableCapsuleModel(store, { environment: "preview" });
  const controller = controllerWith(store, runner, {
    observability,
    metricTags: {
      environment: "test",
      runner_profile_id: "runner_test",
    },
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  const operationMetrics = await observability.listMetrics({
    name: "takosumi_deploy_operation_count",
  });
  expect(operationMetrics.map((metric) => metric.tags)).toContainEqual({
    capsule_id: "cap_fixture1",
    environment: "test",
    operation_kind: "plan",
    runner_profile_id: "runner_test",
    workspace_id: "ws_test001",
    status: "succeeded",
  });
  expect(operationMetrics.map((metric) => metric.tags)).toContainEqual({
    capsule_id: "cap_fixture1",
    environment: "test",
    operation_kind: "apply",
    runner_profile_id: "runner_test",
    workspace_id: "ws_test001",
    status: "succeeded",
  });

  const applyDurations = await observability.listMetrics({
    name: "takosumi_apply_duration_seconds",
  });
  expect(applyDurations).toHaveLength(1);
  expect(applyDurations[0]?.kind).toBe("histogram");
  expect(applyDurations[0]?.tags).toMatchObject({
    capsule_id: "cap_fixture1",
    operation_kind: "apply",
    workspace_id: "ws_test001",
    status: "succeeded",
  });
});

test("capsule apply records an Output and links it from the Run + Capsule", async () => {
  const { store, runner, controller } = await seededController();

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.outputId).toBeDefined();
  const capsule = await store.getCapsule("cap_fixture1");
  expect(capsule?.currentOutputId).toEqual(applyRun.outputId);

  const snapshot = await store.getOutput(applyRun.outputId!);
  expect(snapshot).toBeDefined();
  expect(snapshot?.capsuleId).toEqual("cap_fixture1");
  expect(snapshot?.stateGeneration).toEqual(1);
  expect(snapshot?.rawArtifactRef).toBeDefined();
  expect(snapshot?.rawArtifactRef).toEqual(runner.applyJobs[0]?.rawOutputRef);

  expect(snapshot?.workspaceOutputs).toEqual({
    launch_url: "https://x.example",
  });
  expect(snapshot?.publicOutputs).toEqual({ launch_url: "https://x.example" });

  // The digest is stable + recomputable over the canonical projections.
  const { stableJsonDigest } =
    await import("../../../../core/adapters/source/digest.ts");
  expect(snapshot?.outputDigest).toEqual(
    await stableJsonDigest({
      workspaceOutputs: snapshot!.workspaceOutputs,
      publicOutputs: snapshot!.publicOutputs,
    }),
  );

  // getLatestOutput resolves the same record.
  const latest = await store.getLatestOutput("cap_fixture1");
  expect(latest?.id).toEqual(snapshot?.id);
});

test("capsule apply: a failing ledger commit leaves NO torn state (all-or-nothing)", async () => {
  // Regression guard for the atomic apply-commit (spec §20 / §21 / §16). Every
  // successful-apply ledger write — StateVersion, Output,
  // and the guarded Capsule advance — is funneled through the single
  // `commitRunState` store method. If that method fails (a crash /
  // error mid-write), the controller must NOT have persisted ANY of those
  // records: the run fails and the Capsule stays at its pre-apply
  // generation. (The in-memory store cannot truly roll back without a
  // transaction, so the controller's guarantee is that the WHOLE atomic unit is
  // a single call which here throws before writing anything; the SQL/D1 backends
  // additionally roll back / batch — see store_model_test.ts.)
  const inner = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  await seedRunnableCapsuleModel(inner, { environment: "preview" });
  // Wrap the store so the atomic commit explodes; everything else delegates.
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "commitRunState") {
        return () =>
          Promise.reject(
            new Error("injected: ledger commit crashed mid-write"),
          );
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as OpenTofuControlStore;
  const controller = controllerWith(store, runner);

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  expect(planRun.status).toBe("succeeded");

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  // The apply surfaces the failure rather than reporting a torn success.
  expect(applyRun.status).toBe("failed");

  // The ledger is intact: no new-generation StateVersion, no Output, and the
  // Capsule is NOT advanced (still pending at gen 0 with no current pointers).
  expect(
    await inner.getLatestStateVersion("cap_fixture1", "preview"),
  ).toBeUndefined();
  expect(await inner.getLatestOutput("cap_fixture1")).toBeUndefined();
  const capsule = await inner.getCapsule("cap_fixture1");
  expect(capsule?.status).toBe("pending");
  expect(capsule?.currentStateGeneration).toBe(0);
  expect(capsule?.currentStateVersionId).toBeUndefined();
  expect(capsule?.currentOutputId).toBeUndefined();
});

test("generic Capsule apply projects InstallConfig outputAllowlist outputs", async () => {
  const { store, controller } = await seededController({
    installConfig: {
      outputAllowlist: {
        endpoint: { from: "public_url", type: "url", required: true },
      },
    },
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  const snapshot = await store.getOutput(applyRun.outputId!);
  expect(snapshot?.publicOutputs).toEqual({
    endpoint: "https://public.example",
  });
  expect(snapshot?.workspaceOutputs).toEqual({
    public_url: "https://public.example",
  });
  expect(snapshot?.publicOutputs).not.toHaveProperty("admin_token");
});

test("generic Capsule captures ordinary root Outputs without publishing unallowlisted values", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: {
      outputAllowlist: {
        launch_url: { from: "public_url", type: "url", required: true },
      },
    },
  });
  await store.putCapsuleCompatibilityReport({
    id: "caprep_output_privacy",
    sourceId: seeded.source.id,
    sourceSnapshotId: seeded.snapshot.id,
    level: "ready",
    findings: [],
    providers: [
      { source: "cloudflare/cloudflare", aliases: [], allowed: true },
    ],
    resources: [{ type: "cloudflare_workers_script", count: 1, allowed: true }],
    dataSources: [],
    provisioners: [],
    rootModuleVariables: [],
    rootModuleOutputs: [
      { name: "admin_token", sensitive: true, ephemeral: false },
      { name: "bucket_name", sensitive: false, ephemeral: false },
      { name: "launch_url", sensitive: false, ephemeral: false },
      { name: "public_url", sensitive: false, ephemeral: false },
    ],
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  const { planRun } = await controller.createCapsulePlan(
    seeded.capsule.id,
    {},
    { compatibilityReportId: "caprep_output_privacy" },
  );
  expect(runner.planJobs[0]?.outputAllowlist).toMatchObject({
    bucket_name: { from: "bucket_name" },
    launch_url: { from: "launch_url" },
    public_url: { from: "public_url" },
  });
  expect(runner.planJobs[0]?.outputAllowlist.admin_token).toEqual({
    from: "admin_token",
    type: "json",
    sensitive: true,
  });

  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });
  const snapshot = await store.getOutput(applyRun.outputId!);

  expect(snapshot?.workspaceOutputs).toEqual({
    bucket_name: "my-bucket",
    launch_url: "https://x.example",
    public_url: "https://public.example",
  });
  expect(snapshot?.publicOutputs).toEqual({
    launch_url: "https://public.example",
  });
  expect(JSON.stringify(snapshot)).not.toContain("super-secret-token");
});

test("generic Capsule retains explicit public source Outputs before applying the capture cap", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const seeded = await seedRunnableCapsuleModel(store, {
    environment: "preview",
    installConfig: {
      outputAllowlist: {
        published_endpoint: {
          from: "zz_endpoint",
          type: "url",
          required: true,
        },
      },
    },
  });
  const automaticOutputs = Array.from(
    { length: 128 },
    (_, index) => `auto_${String(index).padStart(3, "0")}`,
  );
  await store.putCapsuleCompatibilityReport({
    id: "caprep_output_cap_priority",
    sourceId: seeded.source.id,
    sourceSnapshotId: seeded.snapshot.id,
    level: "ready",
    findings: [],
    providers: [
      { source: "cloudflare/cloudflare", aliases: [], allowed: true },
    ],
    resources: [{ type: "cloudflare_workers_script", count: 1, allowed: true }],
    dataSources: [],
    provisioners: [],
    rootModuleVariables: [],
    rootModuleOutputs: [...automaticOutputs, "zz_endpoint"].map((name) => ({
      name,
      sensitive: false,
      ephemeral: false,
    })),
    createdAt: "2026-06-07T00:00:00.000Z",
  });
  const profile = multiProviderRunnerProfile();
  const controller = controllerWith(store, runner, {
    runnerProfiles: [profile],
    defaultRunnerProfileId: profile.id,
  });

  await controller.createCapsulePlan(
    seeded.capsule.id,
    {},
    { compatibilityReportId: "caprep_output_cap_priority" },
  );

  const capture = runner.planJobs[0]?.outputAllowlist ?? {};
  expect(Object.keys(capture)).toHaveLength(128);
  expect(capture.zz_endpoint).toEqual({
    from: "zz_endpoint",
    type: "json",
  });
  expect(capture).not.toHaveProperty("published_endpoint");
  expect(capture).not.toHaveProperty("auto_127");
});

test("Workspace capture preserves opaque non-sensitive values while public projection filters them", async () => {
  const { store, controller } = await seededController({
    installConfig: {
      outputAllowlist: {
        status: { from: "public_status", type: "string" },
      },
    },
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  const snapshot = await store.getOutput(applyRun.outputId!);
  expect(snapshot?.publicOutputs).not.toHaveProperty("status");
  expect(snapshot?.workspaceOutputs.public_status).toEqual(
    "sk-output-raw-token",
  );
  expect(snapshot?.publicOutputs).not.toHaveProperty("status");
});

test("Output projection fails closed on required output type mismatch", async () => {
  const { controller } = await seededController({
    installConfig: {
      outputAllowlist: {
        bucket_name: { from: "bucket_name", type: "url", required: true },
      },
    },
  });

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  expect(applyRun.outputId).toBeUndefined();
  expect(applyRun.status).toEqual("failed");
  expect(JSON.stringify(applyRun.diagnostics)).toContain(
    "does not match declared projection type url",
  );
});

test("a sensitive-flagged runner output leaks into NO projection (invariants 11/12)", async () => {
  const { store, controller } = await seededController();

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  const { applyRun } = await controller.createApplyRun({
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  });

  const snapshot = await store.getOutput(applyRun.outputId!);

  // The sensitive value never appears anywhere in the public projections.
  const serializedSnapshot = JSON.stringify(snapshot);
  expect(serializedSnapshot).not.toContain("admin_token");
  expect(serializedSnapshot).not.toContain("super-secret-token");
  expect(snapshot?.workspaceOutputs).not.toHaveProperty("admin_token");
  expect(snapshot?.publicOutputs).not.toHaveProperty("admin_token");

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

test("a second capsule plan reads the bumped generation and its apply moves to gen 2", async () => {
  const { store, runner, controller } = await seededController();

  const first = await controller.createCapsulePlan("cap_fixture1");
  await controller.createApplyRun({
    planRunId: first.planRun.id,
    expected: applyExpectedGuardFromPlanRun(first.planRun),
  });

  // Second plan sees the capsule at generation 1 now.
  const second = await controller.createCapsulePlan("cap_fixture1");
  expect(second.planRun.baseStateGeneration).toEqual(1);
  expect(runner.planJobs[1]!.stateScope?.generation).toEqual(1);

  await controller.createApplyRun({
    planRunId: second.planRun.id,
    expected: applyExpectedGuardFromPlanRun(second.planRun),
  });
  expect(runner.applyJobs[1]!.stateScope?.generation).toEqual(2);
  const latest = await store.getLatestStateVersion("cap_fixture1", "preview");
  expect(latest?.generation).toEqual(2);
});

test("apply is rejected when the plan's SourceSnapshot is no longer present", async () => {
  const { store, controller } = await seededController();

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
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

test("capsule apply is rejected when the state generation advanced since plan", async () => {
  const { store, controller } = await seededController();

  const { planRun } = await controller.createCapsulePlan("cap_fixture1");
  // Simulate a sibling apply advancing the capsule state generation to 1.
  await store.putStateVersion({
    id: "state_sibling",
    workspaceId: "ws_test001",
    capsuleId: "cap_fixture1",
    environment: "preview",
    generation: 1,
    stateRef: "state://ws_test001/cap_fixture1/preview/1",
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

test("capsule destroy-plan apply tears down state at base+1 after approval and marks the capsule destroyed", async () => {
  const { store, runner, controller } = await seededController();

  // Establish a generation-1 state via a create apply first.
  const create = await controller.createCapsulePlan("cap_fixture1");
  const created = await controller.createApplyRun({
    planRunId: create.planRun.id,
    expected: applyExpectedGuardFromPlanRun(create.planRun),
  });
  const createdStateVersionId = created.applyRun.stateVersionId;

  // Destroy-plan lands waiting_approval; approve, then apply.
  const destroy = await controller.createCapsuleDestroyPlan("cap_fixture1");
  expect(destroy.planRun.baseStateGeneration).toEqual(1);
  const waiting = await controller.getRun(destroy.planRun.id);
  expect(waiting.status).toEqual("waiting_approval");
  await controller.approveRun(destroy.planRun.id);

  const { applyRun } = await controller.createApplyRun({
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
  const latest = await store.getLatestStateVersion("cap_fixture1", "preview");
  expect(latest?.generation).toEqual(2);
  expect(latest?.id).toEqual(applyRun.stateVersionId);

  // Destroy records a terminal StateVersion and advances the Capsule cursor.
  const capsule = await store.getCapsule("cap_fixture1");
  expect(capsule?.status).toEqual("destroyed");
  expect(capsule?.currentStateVersionId).toEqual(applyRun.stateVersionId);
  expect(capsule?.currentStateGeneration).toEqual(2);

  expect(createdStateVersionId).toBeDefined();
  expect(await store.getStateVersion(createdStateVersionId!)).toBeDefined();
  expect(
    (await store.listStateVersions("cap_fixture1", "preview")).map(
      (stateVersion) => stateVersion.generation,
    ),
  ).toEqual([1, 2]);
});

test("a second successful apply preserves StateVersion history and advances the cursor", async () => {
  const { store, controller } = await seededController();

  const first = await controller.createCapsulePlan("cap_fixture1");
  const firstApply = await controller.createApplyRun({
    planRunId: first.planRun.id,
    expected: applyExpectedGuardFromPlanRun(first.planRun),
  });
  const firstStateVersionId = firstApply.applyRun.stateVersionId!;

  const second = await controller.createCapsulePlan("cap_fixture1");
  const secondApply = await controller.createApplyRun({
    planRunId: second.planRun.id,
    expected: applyExpectedGuardFromPlanRun(second.planRun),
  });

  expect(await store.getStateVersion(firstStateVersionId)).toBeDefined();
  expect(secondApply.applyRun.stateVersionId).toBeDefined();
  expect(
    (await store.listStateVersions("cap_fixture1", "preview")).map(
      (stateVersion) => stateVersion.generation,
    ),
  ).toEqual([1, 2]);
  expect((await store.getCapsule("cap_fixture1"))?.currentStateVersionId).toBe(
    secondApply.applyRun.stateVersionId,
  );
});

test("OpenTofuControllerError is surfaced for an unknown capsule", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const controller = controllerWith(store, recordingRunner());
  await expect(
    controller.createCapsulePlan("cap_missing"),
  ).rejects.toBeInstanceOf(OpenTofuControllerError);
});
